// ============================================================================
// ULTRA LOW-LATENCY TELEGRAM BOT SERVERLESS HANDLER
// Stack: Telegraf v4 + Upstash Redis REST + Vercel Serverless (Node.js 20+)
// Features: HTTP Keep-Alive Socket Reuse, Parallel Async I/O, HTML Sanitized
// ============================================================================

const https = require('https');
const { Telegraf } = require('telegraf');
const { Redis } = require('@upstash/redis');

// 1. BOOT-TIME ENVIRONMENT ASSERTION
const REQUIRED_ENVS = [
  'BOT_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'ADMIN_ID'
];

for (const envName of REQUIRED_ENVS) {
  if (!process.env[envName] || process.env[envName].trim() === '') {
    throw new Error(`CRITICAL SYSTEM ERROR: Environment Variable [${envName}] is missing!`);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN.trim();
const ADMIN_ID = parseInt(process.env.ADMIN_ID.trim(), 10);
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

if (isNaN(ADMIN_ID)) {
  throw new Error('CRITICAL SYSTEM ERROR: ADMIN_ID must be a valid numeric integer!');
}

// ============================================================================
// 2. HTTP KEEP-ALIVE AGENT (Mencegah Overhead TLS/TCP Handshake pada Warm Starts)
// ============================================================================
const httpAgent = new https.Agent({
  keepAlive: true,          // Menjaga koneksi TCP tetap terbuka
  keepAliveMsecs: 30000,     // Ping TCP Keep-Alive tiap 30 detik
  maxSockets: 64,            // Batas maksimal socket paralel per host
  maxFreeSockets: 10,        // Socket menganggur yang tetap dipertahankan
  timeout: 10000             // Socket idle timeout (10 detik)
});

// 3. SINGLETON CLIENT INITIALIZATION WITH KEEP-ALIVE
const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL.trim(),
  token: process.env.UPSTASH_REDIS_REST_TOKEN.trim(),
});

// Injeksi Agent Keep-Alive ke Telegraf Options
const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    agent: httpAgent
  }
});

// 4. UTILITY HELPER FUNCTIONS
function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function ensureBotInfo() {
  if (!bot.botInfo) {
    bot.botInfo = await bot.telegram.getMe();
  }
}

// ============================================================================
// 5. TELEGRAM BOT HANDLERS
// ============================================================================

// Handler: /start
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const firstName = escapeHtml(ctx.from.first_name || 'User');
  const lastName = escapeHtml(ctx.from.last_name || '');
  const username = ctx.from.username ? `@${escapeHtml(ctx.from.username)}` : 'Tidak ada username';

  if (chatId === ADMIN_ID) {
    return ctx.reply('👋 <b>Halo Admin!</b> Sistem bot operasional dan siap menerima pesan masuk.', {
      parse_mode: 'HTML',
    });
  }

  // Balas user biasa
  await ctx.reply(
    `Halo <b>${firstName}</b>! Selamat datang di bot bantuan kami.\n\n` +
    `Silakan klik tombol di bawah untuk mulai berinteraksi, atau langsung kirimkan pesan Anda di sini.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Hubungi Admin 💬', callback_data: 'prompt_contact' }]
        ]
      }
    }
  );

  // Cek Redis untuk pemisah Notifikasi User Baru
  const isExistingUser = await kv.get(`user_seen:${userId}`);
  if (!isExistingUser) {
    // Paralel: Simpan flag user ke Redis + Kirim Notifikasi ke Admin
    const fullName = `${firstName} ${lastName}`.trim();
    const userHyperlink = `<a href="tg://user?id=${userId}">${fullName}</a>`;
    const adminNotification =
      `🚀 <b>User Baru Memulai Bot!</b>\n\n` +
      `👤 <b>Nama:</b> ${userHyperlink}\n` +
      `🆔 <b>ID User:</b> <code>${userId}</code>\n` +
      `🏷️ <b>Username:</b> ${username}`;

    await Promise.all([
      kv.set(`user_seen:${userId}`, '1', { ex: 2592000 }),
      ctx.telegram.sendMessage(ADMIN_ID, adminNotification, { parse_mode: 'HTML' }).catch(err => {
        console.error('[ERROR] Gagal kirim notifikasi admin:', err.message);
      })
    ]);
  }
});

// Handler: Callback Query Button
bot.action('prompt_contact', async (ctx) => {
  // Parallelization: Jawab Callback & Kirim Pesan Instruksi Bersamaan
  await Promise.all([
    ctx.answerCbQuery(),
    ctx.reply('Silakan ketik atau kirim pesan Anda (Teks, Gambar, Dokumen, Video, Voice Note). Pesan Anda akan langsung diteruskan ke Admin.')
  ]);
});

// Handler: Relay Message Utama (PARALLEL ULTRA LOW-LATENCY)
bot.on('message', async (ctx) => {
  const chatId = ctx.chat.id;
  const messageId = ctx.message.message_id;

  // --- LOGIC A: PESAN DARI ADMIN (REPLY PESAN USER) ---
  if (chatId === ADMIN_ID) {
    if (ctx.message.reply_to_message) {
      const adminReplyToId = ctx.message.reply_to_message.message_id;
      
      const targetUserId = await kv.get(`msg:${adminReplyToId}`);
      
      if (targetUserId) {
        try {
          await ctx.telegram.copyMessage(targetUserId, ADMIN_ID, messageId);
          await ctx.reply('✅ Pesan Anda berhasil terkirim ke user.', {
            reply_to_message_id: messageId
          });
        } catch (err) {
          console.error('[ERROR] CopyMessage to User Failed:', err.message);
          await ctx.reply('❌ Gagal mengirim pesan. Kemungkinan bot telah diblokir oleh user.');
        }
      } else {
        await ctx.reply('❌ Gagal meneruskan pesan. Data sesi pesan ini sudah kedaluwarsa atau tidak ditemukan.');
      }
    } else {
      await ctx.reply(
        '💡 <b>Tips:</b> Untuk membalas pesan user, silakan gunakan fitur <b>Reply</b> langsung pada pesan kiriman user tersebut.',
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  // --- LOGIC B: PESAN DARI USER (ULTRA FAST RELAY KE ADMIN) ---
  try {
    // 1. Forward ke Admin dulu untuk dapat Message ID acuan
    const forwardedToAdmin = await ctx.telegram.copyMessage(ADMIN_ID, chatId, messageId);
    
    // 2. PARALLEL EXECUTION: Tembak Upstash Redis & Reply User secara SIKRON BERSAMAAN
    // Memangkas Latensi hingga ~50%
    await Promise.all([
      kv.set(`msg:${forwardedToAdmin.message_id}`, chatId, { ex: 604800 }),
      ctx.reply('✅ Pesan Anda telah terkirim ke Admin. Mohon tunggu balasan.', {
        reply_to_message_id: messageId
      })
    ]);

  } catch (error) {
    console.error('[ERROR] Forwarding to Admin Failed:', error.message);
    await ctx.reply('❌ Terjadi gangguan sistem, pesan Anda gagal diteruskan ke Admin. Silakan coba lagi nanti.');
  }
});

// ============================================================================
// 6. VERCEL SERVERLESS WEBHOOK ENTRY POINT
// ============================================================================
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('🚀 Bot System is Online and Active with HTTP Keep-Alive.');
  }

  // Security Check Header Secret Token
  if (WEBHOOK_SECRET) {
    const incomingToken = req.headers['x-telegram-bot-api-secret-token'];
    if (incomingToken !== WEBHOOK_SECRET) {
      console.warn('[SECURITY] Unauthorized Webhook Access Attempt Blocked.');
      return res.status(401).send('Unauthorized Request');
    }
  }

  try {
    await ensureBotInfo();

    if (req.body && typeof req.body === 'object') {
      await bot.handleUpdate(req.body);
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('[CRITICAL] Unhandled Serverless Execution Error:', err);
    return res.status(200).send('Handled Exception');
  }
};
