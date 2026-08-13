import os
import asyncio
from aiogram import Bot, Dispatcher, F, Router
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message, FSInputFile, ReplyKeyboardMarkup, KeyboardButton, ReplyKeyboardRemove
from mutagen.id3 import ID3, TIT2, TPE1, APIC, ID3NoHeaderError

# -------------------------------------------------------------
# Токен вашего бота
BOT_TOKEN = "8738802310:AAF4P7Ef4sQDEuE0NyI0QWqNsGdidZh9EyM"
# -------------------------------------------------------------

class EditMP3(StatesGroup):
    waiting_for_audio = State()
    waiting_for_title = State()
    waiting_for_artist = State()
    waiting_for_cover = State()

router = Router()

skip_keyboard = ReplyKeyboardMarkup(
    keyboard=[[KeyboardButton(text="Пропустить обложку")]],
    resize_keyboard=True,
    one_time_keyboard=True
)

@router.message(F.command("start"))
async def start_cmd(message: Message, state: FSMContext):
    await state.clear()
    await message.answer("Привет! 🎵 Отправь мне **MP3-файл**, и я помогу изменить его название, исполнителя и обложку.")

# Принимает файл и как «Музыку», и как «Документ .mp3»
@router.message(F.audio | (F.document & F.document.file_name.endswith('.mp3')))
async def process_audio(message: Message, state: FSMContext):
    file_id = message.audio.file_id if message.audio else message.document.file_id
    await state.update_data(audio_file_id=file_id)
    await state.set_state(EditMP3.waiting_for_title)
    await message.answer("1/3 Отлично! Напиши **новое название песни**:", reply_markup=ReplyKeyboardRemove())

@router.message(EditMP3.waiting_for_title)
async def process_title(message: Message, state: FSMContext):
    await state.update_data(title=message.text)
    await state.set_state(EditMP3.waiting_for_artist)
    await message.answer("2/3 Принято. Теперь напиши **имя исполнителя**:")

@router.message(EditMP3.waiting_for_artist)
async def process_artist(message: Message, state: FSMContext):
    await state.update_data(artist=message.text)
    await state.set_state(EditMP3.waiting_for_cover)
    await message.answer(
        "3/3 Замечательно! Теперь **пришли картинку** для обложки (как фото) "
        "или нажми кнопку ниже, чтобы оставить старую:",
        reply_markup=skip_keyboard
    )

@router.message(EditMP3.waiting_for_cover)
async def process_cover(message: Message, state: FSMContext, bot: Bot):
    has_photo = bool(message.photo)
    is_skip = message.text == "Пропустить обложку"

    if not has_photo and not is_skip:
        await message.answer("Пожалуйста, пришли изображение как **фото** или нажми кнопку **«Пропустить обложку»**.")
        return

    data = await state.get_data()
    user_id = message.from_user.id
    
    msg = await message.answer("⏳ Обрабатываю файл, подождите...", reply_markup=ReplyKeyboardRemove())
    
    audio_path = f"temp_{user_id}.mp3"
    cover_path = f"temp_{user_id}.jpg"
    
    try:
        await bot.download(data['audio_file_id'], destination=audio_path)
        
        if has_photo:
            await bot.download(message.photo[-1].file_id, destination=cover_path)
        
        try:
            audio = ID3(audio_path)
        except ID3NoHeaderError:
            audio = ID3()

        audio.add(TIT2(encoding=3, text=data['title']))
        audio.add(TPE1(encoding=3, text=data['artist']))
        
        if has_photo and os.path.exists(cover_path):
            with open(cover_path, 'rb') as albumart:
                audio.add(APIC(
                    encoding=3,
                    mime='image/jpeg',
                    type=3,
                    desc='Cover',
                    data=albumart.read()
                ))
                
        audio.save(audio_path)
        
        final_audio = FSInputFile(audio_path, filename=f"{data['artist']} - {data['title']}.mp3")
        await bot.send_audio(
            chat_id=message.chat.id, 
            audio=final_audio,
            title=data['title'],
            performer=data['artist']
        )
    except Exception as e:
        await message.answer(f"❌ Произошла ошибка при обработке: {e}")
    finally:
        if os.path.exists(audio_path):
            os.remove(audio_path)
        if os.path.exists(cover_path):
            os.remove(cover_path)
        await state.clear()
        await msg.delete()

async def main():
    bot = Bot(token=BOT_TOKEN)
    dp = Dispatcher()
    dp.include_router(router)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
