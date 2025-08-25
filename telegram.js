import { Telegraf } from 'telegraf';

export const sendTelegramMessage = async (token, chatId, message) => {
  if (!token || !chatId) {
    console.log('Telegram token or chat ID is not set. Skipping message.');
    return;
  }

  const bot = new Telegraf(token);

  try {
    await bot.telegram.sendMessage(chatId, message);
  } catch (err) {
    console.error(`Failed to send Telegram message: ${err.message}`);
  }
};
