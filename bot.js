require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { Client } = require('pg');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

/* ======== Banco ======== */
const db = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});
db.connect().then(() => log.info('📦 Conectado ao Postgres')).catch(err => { log.error(err); process.exit(1); });


/* ==================================== */
/* ============ Utilidades ============ */
/* ==================================== */

function normJid(j) {
  if (!j) return null;
  try { return jidNormalizedUser(j); } catch { }
  const [u, d = 's.whatsapp.net'] = j.split('@');
  return `${u.split(':')[0]}@${d === 'lid' ? 's.whatsapp.net' : d}`;
}
function textOf(m) {
  let mm = m?.message;
  if (!mm) return '';
  if (mm.ephemeralMessage) mm = mm.ephemeralMessage.message;
  if (mm.viewOnceMessage) mm = mm.viewOnceMessage.message;
  return mm.conversation || mm.extendedTextMessage?.text || mm.imageMessage?.caption || mm.videoMessage?.caption || '';
}


/* ============ !addcargo e outros  ============ */

// pega menções reais do WhatsApp (se houver)
function getMentionedJids(msg) {
  const ctx = msg?.message?.extendedTextMessage?.contextInfo;
  const list = ctx?.mentionedJid || [];
  return list.map(j => j && jidNormalizedUser(j)).filter(Boolean);
}

// da cargo recruta como default, para não poluir o banco
async function getDefaultCargo() {
  // Maiores números = menos poder; o último é o default (Recruta)
  const r = await db.query('SELECT id, nome, nivel FROM cargos ORDER BY nivel DESC LIMIT 1');
  return r.rows[0]; // { id, nome, nivel }
}

// busca cargo por nome (case-insensitive)
async function findCargoByName(nome) {
  const clean = normalizeName(nome);
  const r = await db.query(
    `SELECT id, nome, nivel
       FROM cargos
      WHERE LOWER(unaccent(nome)) = LOWER(unaccent($1))
      LIMIT 1`,
    [clean]
  );
  return r.rowCount ? r.rows[0] : null;
}

// retorna {nivel, cargo_id, exists, is_blocked}; cria como recruta se ensure=true e não existir
async function getUserInfoByJid(jid, ensure = false) {
  const q = `
    SELECT u.cargo_id, u.is_blocked, c.nivel
    FROM users u
    LEFT JOIN cargos c ON u.cargo_id = c.id
    WHERE u.jid = $1
  `;
  const r = await db.query(q, [jid]);
  if (r.rowCount) {
    return { exists: true, cargo_id: r.rows[0].cargo_id, nivel: r.rows[0].nivel, is_blocked: r.rows[0].is_blocked };
  }

  // não existe no banco
  if (!ensure) {
    const def = await getDefaultCargo(); // Recruta
    return { exists: false, cargo_id: null, nivel: def.nivel, is_blocked: false };
  }

  // ensure = true => cria como Recruta
  const def = await getDefaultCargo();
  await db.query('INSERT INTO users (jid, cargo_id) VALUES ($1, $2)', [jid, def.id]);
  return { exists: true, cargo_id: def.id, nivel: def.nivel, is_blocked: false };
}

// upsert do cargo do usuário com auditoria
async function setUserCargo(targetJid, cargoId, giverJid) {
  await db.query(
    `INSERT INTO users (jid, cargo_id, rank_giver_id, last_rank_date, is_blocked)
     VALUES ($1, $2, $3, NOW(), FALSE)
     ON CONFLICT (jid) DO UPDATE
       SET cargo_id=$2, rank_giver_id=$3, last_rank_date=NOW()`,
    [targetJid, cargoId, giverJid]
  );
}

// verifica permissão do comando e mensagens de erro padronizadas
async function requirePerm(sock, chat, quotedMsg, senderJid, cmd) {
  const user = await getUserInfoByJid(senderJid, false); // << NÃO cria
  if (user.is_blocked) {
    await sock.sendMessage(chat, { text: '🚫 Você está bloqueado.' }, { quoted: quotedMsg });
    return false;
  }
  const r = await db.query('SELECT nivel_minimo, ativo FROM comandos WHERE nome=$1', [cmd]);
  if (!r.rowCount || !r.rows[0].ativo) {
    await sock.sendMessage(chat, { text: 'Comando desconhecido ou desativado.' }, { quoted: quotedMsg });
    return false;
  }
  const need = r.rows[0].nivel_minimo;
  if (user.nivel > need) {
    await sock.sendMessage(chat, { text: '🚫 Sem permissão.' }, { quoted: quotedMsg });
    return false;
  }
  return true;
}

// Função para normalizar strings dos comandos (remover acentos, converter para minúsculas, etc.)
function normalizeName(str) {
  return (str || '')
    .normalize('NFD')                  // separa acentos
    .replace(/[\u0300-\u036f]/g, '')    // remove diacríticos
    .toLowerCase()
    .trim();
}

/* ============ !all ============ */


async function getGroupParticipantJids(sock, groupJid) {
  const meta = await sock.groupMetadata(groupJid);
  return meta.participants.map(p => jidNormalizedUser(p.id));
}

/* ============ !perdi e outros ============ */
// Incrementa contador
async function incCounter(name) {
  const r = await db.query(
    `INSERT INTO counters (counter_name, value)
     VALUES ($1, 1)
     ON CONFLICT (counter_name)
     DO UPDATE SET value = counters.value + 1, last_update = NOW()
     RETURNING value`,
    [name]
  );
  return r.rows[0].value;
}



/* ==================================== */
/* ======== FIM DAS Utilidades ======== */
/* ==================================== */


/* ======== Funções de Permissão ======== */

// garante que o usuário existe e retorna nível do cargo e bloqueio
async function getUserLevel(jid) {
  const q = `
    SELECT c.nivel, u.is_blocked
    FROM users u
    LEFT JOIN cargos c ON u.cargo_id = c.id
    WHERE u.jid = $1
  `;
  const r = await db.query(q, [jid]);
  if (!r.rowCount) {
    const cargo = await db.query(`SELECT id, nivel FROM cargos ORDER BY nivel DESC LIMIT 1`);
    const cargoId = cargo.rows[0].id;
    await db.query('INSERT INTO users (jid, cargo_id) VALUES ($1, $2)', [jid, cargoId]);
    return { nivel: cargo.rows[0].nivel, is_blocked: false };
  }
  return { nivel: r.rows[0].nivel, is_blocked: r.rows[0].is_blocked };
}

// verifica se o usuário tem permissão para um comando
async function checkPermission(jid, cmd) {
  const user = await getUserLevel(jid);
  if (user.is_blocked) return { ok: false, reason: 'blocked' };

  const r = await db.query('SELECT nivel_minimo, ativo FROM comandos WHERE nome=$1', [cmd]);
  if (!r.rowCount || !r.rows[0].ativo) return { ok: false, reason: 'notfound' };

  const need = r.rows[0].nivel_minimo;
  if (user.nivel > need) return { ok: false, reason: 'denied' };

  return { ok: true };
}

/* ======== Fim das Funções de Permissão ======== */

/* ======== Bot ======== */
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, logger: log, auth: state, markOnlineOnConnect: false });

  sock.ev.on('connection.update', u => {
    if (u.qr) qrcode.generate(u.qr, { small: true });
    if (u.connection === 'open') log.info('✅ Conectado');
    if (u.connection === 'close' && (u.lastDisconnect?.error?.output?.statusCode ?? 0) !== DisconnectReason.loggedOut) start();
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async up => {
    const m = up.messages?.[0];
    if (!m || m.key.fromMe || up.type !== 'notify') return;

    const chat = m.key.remoteJid;
    if (!chat || chat === 'status@broadcast') return;
    const sender = normJid(chat.endsWith('@g.us') ? m.key.participant : chat);
    if (!sender) return;

    const text = textOf(m).trim();
    if (!text.startsWith('!')) return;

    const [rawCmd] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase();

    // checa permissão centralizada
    const perm = await checkPermission(sender, cmd);
    if (!perm.ok) {
      const msg =
        perm.reason === 'blocked' ? '🚫 Você está bloqueado.' :
          perm.reason === 'notfound' ? 'Comando desconhecido ou desativado.' :
            '🚫 Sem permissão.';
      await sock.sendMessage(chat, { text: msg }, { quoted: m });
      return;
    }

    // --- SWITCH PRINCIPAL ---
    switch (cmd) {

      // comando de teste que também usa a mesma verificação
      case '!teste':
        await sock.sendMessage(chat, { text: '✅ Comando de teste executado!' }, { quoted: m });
        break;

      case '!ping':
        await sock.sendMessage(chat, { text: '🏓 Pong!' }, { quoted: m });
        break;

      case '!id':
        const info = [
          `👤 *Seu JID:* ${sender}`,
          `💬 *Chat JID:* ${chat} ${chat.endsWith('@g.us') ? '(grupo)' : '(privado)'}`,
          `🤖 *Bot JID:* ${normJid(sock.user.id)}`
        ].join('\n');
        await sock.sendMessage(chat, { text: info }, { quoted: m });
        break;

      case '!addcargo': {
        // checa permissão deste comando apenas aqui
        if (!(await requirePerm(sock, chat, m, sender, '!addcargo'))) break;

        // precisa estar em grupo pra mencionar gente com facilidade (opcional, mas prático)
        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, { text: 'Use em um grupo (com @mencionar) ou passe o número.' }, { quoted: m });
          break;
        }

        // alvo: prioridade para menção real
        let targets = getMentionedJids(m);

        // se não mencionou, aceita número como primeiro argumento
        const tokens = text.split(/\s+/);
        // tokens[0] = !addcargo
        if (targets.length === 0 && tokens[1]) {
          const digits = tokens[1].replace(/[^\d]/g, '');
          if (digits.length >= 10) {
            targets = [jidNormalizedUser(`${digits}@s.whatsapp.net`)];
          }
        }

        if (targets.length === 0) {
          await sock.sendMessage(chat, { text: 'Uso: !addcargo @usuario <Cargo>' }, { quoted: m });
          break;
        }

        // nome do cargo: tudo que vier após o alvo
        const cargoNome = tokens.slice(2).join(' ').trim();
        if (!cargoNome) {
          await sock.sendMessage(chat, { text: 'Informe o cargo. Ex.: !addcargo @usuario Capitão' }, { quoted: m });
          break;
        }

        const cargo = await findCargoByName(cargoNome);
        if (!cargo) {
          await sock.sendMessage(chat, { text: `Cargo não encontrado: ${cargoNome}` }, { quoted: m });
          break;
        }

        // regras de hierarquia:
        // menor nivel = mais poder
        // quem dá o cargo (sender) precisa ter nivel <= cargo.nivel E nivel <= nivel atual do alvo
        const giver = await getUserInfoByJid(sender, false);

        const okList = [];
        const failList = [];

        // metadata do grupo pra validar membro (evita atribuir cargo pra quem nunca falou)
        const meta = await sock.groupMetadata(chat);
        const members = new Set(meta.participants.map(p => jidNormalizedUser(p.id)));

        for (const t of targets) {
          // aceita dar cargo pra alguém do grupo; se não estiver no grupo, ainda dá pra registrar no banco (sua escolha)
          // aqui vamos permitir mesmo se não estiver no grupo, já que você quer testar DB
          const alvo = await getUserInfoByJid(t, true); // garante registro

          // checa hierarquia
          const giverOkToSetThisCargo = giver.nivel <= cargo.nivel;
          const giverOkOverTarget = giver.nivel <= (alvo.nivel ?? cargo.nivel); // se alvo sem cargo conhecido, usa cargo do insert

          if (!giverOkToSetThisCargo || !giverOkOverTarget) {
            failList.push(t);
            continue;
          }

          // aplica
          await setUserCargo(t, cargo.id, sender);
          okList.push(t);
        }

        // resposta
        if (okList.length) {
          await sock.sendMessage(
            chat,
            {
              text: `✅ Cargo *${cargo.nome}* atribuído a:\n${okList.map(j => `@${j.split('@')[0]}`).join('\n')}`,
              mentions: okList
            },
            { quoted: m }
          );
        }
        if (failList.length) {
          await sock.sendMessage(
            chat,
            {
              text: `❌ Sem poder suficiente para:\n${failList.map(j => `@${j.split('@')[0]}`).join('\n')}`,
              mentions: failList
            },
            { quoted: m }
          );
        }
        break;
      }

      case '!all': {
        // permissão deste comando (apenas aqui)
        if (!(await requirePerm(sock, chat, m, sender, '!all'))) break;

        // precisa ser grupo
        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, { text: 'Use este comando em um grupo.' }, { quoted: m });
          break;
        }

        // participantes do grupo
        const members = await getGroupParticipantJids(sock, chat);

        // tira o próprio bot da lista
        const botJid = jidNormalizedUser(sock.user.id);
        const mentions = members.filter(j => j !== botJid);

        if (!mentions.length) {
          await sock.sendMessage(chat, { text: 'Não há membros para mencionar.' }, { quoted: m });
          break;
        }

        // texto leve; você pode trocar a frase
        const texto = '📍 Chamando geral 📍';

        await sock.sendMessage(chat, { text: texto, mentions }, { quoted: m });
        break;
      }

      case '!dado': {
        if (!(await requirePerm(sock, chat, m, sender, '!dado'))) break;

        // separa os tokens: !dado 3d6
        const tokens = text.split(/\s+/);
        if (tokens.length < 2) {
          await sock.sendMessage(chat, { text: '🎲 Uso: !dado XdY (ex: !dado 3d6)' }, { quoted: m });
          break;
        }

        const match = tokens[1].toLowerCase().match(/^(\d+)d(\d+)$/);
        if (!match) {
          await sock.sendMessage(chat, { text: '⚠️ Formato inválido. Ex.: !dado 3d6' }, { quoted: m });
          break;
        }

        const qtd = parseInt(match[1]);
        const faces = parseInt(match[2]);
        if (qtd < 1 || faces < 1 || qtd > 20) {
          await sock.sendMessage(chat, { text: '⚠️ Máx. 20 dados, e mínimo 1.' }, { quoted: m });
          break;
        }

        const rolls = Array.from({ length: qtd }, () => Math.floor(Math.random() * faces) + 1);
        const total = rolls.reduce((a, b) => a + b, 0);

        const result = `🎲 Resultado: *${qtd}d${faces}*\n${rolls.join(', ')} → Total: *${total}*`;
        await sock.sendMessage(chat, { text: result }, { quoted: m });
        break;
      }

      case '!s': {
        if (!(await requirePerm(sock, chat, m, sender, '!s'))) break;

        // pega tipo da mensagem
        const type = Object.keys(m.message || {})[0];

        // se é imagem direta
        let mediaMsg;
        if (type === 'imageMessage') {
          mediaMsg = m;
        }
        // ou se é resposta a uma imagem
        else if (m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
          mediaMsg = {
            key: {
              remoteJid: chat,
              id: m.message.extendedTextMessage.contextInfo.stanzaId,
              fromMe: false,
              participant: m.message.extendedTextMessage.contextInfo.participant,
            },
            message: m.message.extendedTextMessage.contextInfo.quotedMessage,
          };
        }

        if (!mediaMsg) {
          await sock.sendMessage(chat, { text: '⚠️ Envie ou responda a uma imagem para criar figurinha.' }, { quoted: m });
          break;
        }

        // baixa e converte
        try {
          const { downloadMediaMessage } = require('@whiskeysockets/baileys');
          const sharp = require('sharp');

          const buffer = await downloadMediaMessage(
            mediaMsg,
            'buffer',
            {},
            { logger: log, reuploadRequest: sock.updateMediaMessage }
          );

          const webp = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 80 })
            .toBuffer();

          await sock.sendMessage(chat, { sticker: webp }, { quoted: m });
        } catch (err) {
          log.error('Erro no !s', err);
          await sock.sendMessage(chat, { text: '❌ Erro ao criar figurinha.' }, { quoted: m });
        }
        break;
      }

      case '!cargo': {
        if (!(await requirePerm(sock, chat, m, sender, '!cargo'))) break;

        const q = `
    SELECT c.nome, c.nivel, u.rank_giver_id, u.last_rank_date
    FROM users u
    LEFT JOIN cargos c ON u.cargo_id = c.id
    WHERE u.jid = $1
  `;
        const r = await db.query(q, [sender]);

        let cargo = 'Recruta';
        let nivel = null;
        let por = null;
        let desde = null;

        if (r.rowCount) {
          cargo = r.rows[0].nome || 'Recruta';
          nivel = r.rows[0].nivel;
          por = r.rows[0].rank_giver_id;
          desde = r.rows[0].last_rank_date;
        }

        let txt = `🏷️ Seu cargo: *${cargo}*`;
        if (por) txt += `\n👤 Atribuído por: @${por.split('@')[0]}`;
        if (desde) txt += `\n📅 Desde: ${new Date(desde).toLocaleDateString('pt-BR')}`;

        await sock.sendMessage(chat, { text: txt, mentions: por ? [por] : [] }, { quoted: m });
        break;
      }

      case '!sorteio': {
        if (!(await requirePerm(sock, chat, m, sender, '!sorteio'))) break;

        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, { text: '⚠️ Use este comando em um grupo.' }, { quoted: m });
          break;
        }

        const tokens = text.split(/\s+/);
        const qtd = tokens[1] ? parseInt(tokens[1]) : 1;
        if (!qtd || qtd < 1) {
          await sock.sendMessage(chat, { text: 'Uso: !sorteio <quantidade>' }, { quoted: m });
          break;
        }

        const meta = await sock.groupMetadata(chat);
        const botJid = jidNormalizedUser(sock.user.id);
        const members = meta.participants
          .map(p => jidNormalizedUser(p.id))
          .filter(j => j !== botJid);

        if (members.length < qtd) {
          await sock.sendMessage(chat, { text: 'Participantes insuficientes para o sorteio.' }, { quoted: m });
          break;
        }

        // escolhe aleatoriamente sem repetir
        const escolhidos = [];
        const pool = [...members];
        for (let i = 0; i < qtd; i++) {
          const idx = Math.floor(Math.random() * pool.length);
          escolhidos.push(pool.splice(idx, 1)[0]);
        }

        const msg = escolhidos.length === 1
          ? `🎉 O sorteado foi: @${escolhidos[0].split('@')[0]}`
          : `🎉 Sorteados:\n${escolhidos.map(j => `@${j.split('@')[0]}`).join('\n')}`;

        await sock.sendMessage(chat, { text: msg, mentions: escolhidos }, { quoted: m });
        break;
      }

      case '!setnivel': {
        // só Dono (nível 0) pode mudar nível de comando
        if (!(await requirePerm(sock, chat, m, sender, '!setnivel'))) break;

        const tokens = text.split(/\s+/);
        // tokens[0] = !setnivel
        const alvoCmd = tokens[1]?.toLowerCase();
        const novoNivel = parseInt(tokens[2]);

        if (!alvoCmd || isNaN(novoNivel)) {
          await sock.sendMessage(chat, { text: 'Uso: !setnivel <comando> <novo_nivel>\nEx: !setnivel !dado 4' }, { quoted: m });
          break;
        }

        // checa se comando existe
        const check = await db.query('SELECT id FROM comandos WHERE nome=$1', [alvoCmd]);
        if (!check.rowCount) {
          await sock.sendMessage(chat, { text: `Comando não encontrado: ${alvoCmd}` }, { quoted: m });
          break;
        }

        // atualiza nivel_minimo
        await db.query('UPDATE comandos SET nivel_minimo=$1 WHERE nome=$2', [novoNivel, alvoCmd]);

        await sock.sendMessage(chat, { text: `✅ Nível do comando *${alvoCmd}* alterado para *${novoNivel}*.` }, { quoted: m });
        break;
      }

      case '!perdi': {
        if (!(await requirePerm(sock, chat, m, sender, '!perdi'))) break;

        if (!chat.endsWith('@g.us')) {
          await sock.sendMessage(chat, { text: '⚠️ Use este comando em um grupo.' }, { quoted: m });
          break;
        }

        try {
          const total = await incCounter('perdi');
          await sock.sendMessage(chat, { text: `😔 Perdemos *${total}* vez(es).` }, { quoted: m });
        } catch (e) {
          log.error('Erro no !perdi', e);
          await sock.sendMessage(chat, { text: '❌ Não consegui registrar agora.' }, { quoted: m });
        }
        break;
      }

    }
  });
}

start().catch(e => { console.error('Falha ao iniciar bot:', e); process.exit(1); });
