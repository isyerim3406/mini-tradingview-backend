import axios from 'axios';

/**
 * Gönderilen timestamp'i Türkçe formatta tarih ve saat string'ine çevirir.
 * @param {number} timestamp - Geçerli zaman damgası (milisecond)
 * @returns {string} Türkçe formatta tarih ve saat
 */
export const getTurkishDateTime = (timestamp) => {
    const date = new Date(timestamp);
    const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Europe/Istanbul'
    };
    return date.toLocaleString('tr-TR', options);
};

/**
 * Belirtilen Telegram botuna mesaj gönderir.
 * @param {string} token - Telegram Bot Token
 * @param {string} chatId - Hedef chat ID
 * @param {string} message - Gönderilecek mesaj
 */
export const sendTelegramMessage = async (token, chatId, message) => {
    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('✅ Telegram mesajı başarıyla gönderildi.');
    } catch (error) {
        console.error('❌ Telegram mesajı gönderilirken hata oluştu:', error.message);
    }
};
