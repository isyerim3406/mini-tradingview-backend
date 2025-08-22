import fetch from 'node-fetch';

export async function sendTelegramMessage(token, chatId, message) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const data = {
    chat_id: chatId,
    text: message,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    const result = await response.json();
    if (!result.ok) {
      console.error('Telegram API error:', result.description);
    }
  } catch (error) {
    console.error('Telegram\'a mesaj gönderilemedi:', error);
  }
}