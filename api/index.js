const { Telegraf } = require('telegraf');
const { Redis } = require('@upstash/redis');

// Inisialisasi Upstash Redis secara langsung
const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID; // ID Chat Admin

// Handler saat user menekan /start
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const firstName = ctx.from.first_name || 'User';
  const lastName = ctx.from.last_name || '';
  const username = ctx.from.username ? `@${ctx.from.username}` : 'Tidak ada username';

  if (chatId.toString() === ADMIN_ID.toString()) {
    return ctx.reply('👋 Halo Admin! Sistem bot operasional dan siap menerima pesan masuk.');
  }

  await ctx.reply(
    `Halo *${firstName}*! Selamat datang di bot bantuan kami.\n\n` +
    `Silakan klik tombol di bawah untuk mulai berinteraksi, atau langsung kirimkan pesan Anda di sini.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Hubungi Admin 💬', callback_data: 'prompt_contact' }]
        ]
      }
    }
  );

  const userHyperlink = `<a href="tg://user?id=${userId}">${firstName} ${lastName}</a>`;
  
  const adminNotification = 
    `🚀 <b>User Baru Memulai Bot!</b>\n\n` +
    `👤 <b>Nama:</b> ${userHyperlink}\n` +
    `🆔 <b>ID User:</b> <code>${userId}</code>\n` +
    `🏷️ <b>Username:</b> ${username}`;

  try {
    await ctx.telegram.sendMessage(ADMIN_ID, adminNotification, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Gagal mengirim notifikasi ke admin:', error);
  }
});

bot.action('prompt_contact', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('Silakan ketik atau kirim apa saja (Teks, Gambar, Dokumen, Video, Voice Note). Pesan Anda akan langsung diteruskan ke Admin.');
});

// Handler Utama untuk memproses semua jenis pesan masuk
bot.on('message', async (ctx) => {
  const chatId = ctx.chat.id;
  const messageId = ctx.message.message_id;

  // --- BLOK LOGIC UNTUK ADMIN (MEMBALAS PESAN USER) ---
  if (chatId.toString() === ADMIN_ID.toString()) {
    if (ctx.message.reply_to_message) {
      const adminReplyToId = ctx.message.reply_to_message.message_id;
      
      // Ambil ID user asli dari Upstash Redis
      const targetUserId = await kv.get(`msg:${adminReplyToId}`);
      
      if (targetUserId) {
        try {
          await ctx.telegram.copyMessage(targetUserId, ADMIN_ID, messageId);
          await ctx.reply('✅ Pesan Anda berhasil terkirim ke user.', { reply_to_message_id: messageId });
        } catch (err) {
          await ctx.reply('❌ Gagal mengirim pesan. Kemungkinan bot telah diblokir oleh user.');
        }
      } else {
        await ctx.reply('❌ Gagal meneruskan pesan. Data session pesan ini sudah kedaluwarsa atau tidak ditemukan.');
      }
    } else {
      await ctx.reply('💡 <b>Tips:</b> Untuk membalas pesan user, silakan gunakan fitur <b>Reply</b> langsung pada pesan kiriman user tersebut.');
    }
    return;
  }

  // --- BLOK LOGIC UNTUK USER (MENGIRIM PESAN KE ADMIN) ---
  try {
    const forwardedToAdmin = await ctx.telegram.copyMessage(ADMIN_ID, chatId, messageId);
    
    // Simpan relasi ke Upstash Redis dengan expire otomatis 7 hari
    await kv.set(`msg:${forwardedToAdmin.message_id}`, chatId, { ex: 604800 });
    
  } catch (error) {
    console.error('Error forwarding to admin:', error);
    await ctx.reply('❌ Terjadi gangguan sistem, pesan Anda gagal diteruskan ke Admin. Silakan coba lagi nanti.');
  }
});

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
      res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook Error:', err);
      res.status(500).send('Internal Server Error');
    }
  } else {
    res.status(200).send('Bot berjalan dengan sukses!');
  }
};
