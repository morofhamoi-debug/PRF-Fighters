import os
import telebot
from telebot import types
from mutagen.id3 import ID3, TIT2, TPE1, APIC, ID3NoHeaderError

BOT_TOKEN = "8738802310:AAF4P7Ef4sQDEuE0NyI0QWqNsGdidZh9EyM"
bot = telebot.TeleBot(BOT_TOKEN)
data = {}

@bot.message_handler(commands=['start'])
def start(msg):
    bot.send_message(msg.chat.id, "Привет! 🎵 Отправь мне MP3-файл.")

@bot.message_handler(content_types=['audio', 'document'])
def get_audio(msg):
    file_id = msg.audio.file_id if msg.audio else (msg.document.file_id if msg.document and msg.document.file_name.endswith('.mp3') else None)
    if not file_id:
        return bot.send_message(msg.chat.id, "Нужен MP3-файл!")
    
    data[msg.chat.id] = {'file_id': file_id}
    next_msg = bot.send_message(msg.chat.id, "1/3 Напиши **новое название**:")
    bot.register_next_step_handler(next_msg, get_title)

def get_title(msg):
    data[msg.chat.id]['title'] = msg.text
    next_msg = bot.send_message(msg.chat.id, "2/3 Напиши **исполнителя**:")
    bot.register_next_step_handler(next_msg, get_artist)

def get_artist(msg):
    data[msg.chat.id]['artist'] = msg.text
    kb = types.ReplyKeyboardMarkup(resize_keyboard=True, one_time_keyboard=True)
    kb.add("Пропустить обложку")
    next_msg = bot.send_message(msg.chat.id, "3/3 Пришли **фото** для обложки или нажми кнопку:", reply_markup=kb)
    bot.register_next_step_handler(next_msg, get_cover)

def get_cover(msg):
    uid = msg.chat.id
    has_photo = bool(msg.photo)
    
    bot.send_message(uid, "⏳ Обрабатываю...", reply_markup=types.ReplyKeyboardRemove())
    
    f_audio = f"t_{uid}.mp3"
    f_cover = f"t_{uid}.jpg"
    
    try:
        # Скачиваем файл
        file_info = bot.get_file(data[uid]['file_id'])
        with open(f_audio, 'wb') as f:
            f.write(bot.download_file(file_info.file_path))
            
        if has_photo:
            p_info = bot.get_file(msg.photo[-1].file_id)
            with open(f_cover, 'wb') as f:
                f.write(bot.download_file(p_info.file_path))

        # Теги
        try:
            audio = ID3(f_audio)
        except ID3NoHeaderError:
            audio = ID3()

        audio.add(TIT2(encoding=3, text=data[uid]['title']))
        audio.add(TPE1(encoding=3, text=data[uid]['artist']))
        
        if has_photo and os.path.exists(f_cover):
            with open(f_cover, 'rb') as img:
                audio.add(APIC(encoding=3, mime='image/jpeg', type=3, desc='Cover', data=img.read()))
                
        audio.save(f_audio)
        
        # Отправка обратно
        with open(f_audio, 'rb') as f:
            bot.send_audio(uid, f, title=data[uid]['title'], performer=data[uid]['artist'])
            
    except Exception as e:
        bot.send_message(uid, f"Ошибка: {e}")
    finally:
        for p in (f_audio, f_cover):
            if os.path.exists(p): os.remove(p)

if __name__ == "__main__":
    bot.infinity_polling()
