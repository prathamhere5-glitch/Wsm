import os
import time
import random
import logging
import sqlite3
import threading
from datetime import datetime
import pytz
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, CallbackQueryHandler, MessageHandler, filters

# Load environment variables
load_dotenv()
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
IST = pytz.timezone('Asia/Kolkata')

# Logging setup
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# Database setup
def init_db():
    conn = sqlite3.connect('bot_data.db')
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users 
                 (user_id INTEGER PRIMARY KEY, delay INTEGER DEFAULT 200, schedule_time TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS accounts 
                 (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, phone TEXT, session_path TEXT)''')
    conn.commit()
    conn.close()

init_db()

# Helper functions
def get_user_config(user_id):
    conn = sqlite3.connect('bot_data.db')
    c = conn.cursor()
    c.execute("SELECT delay, schedule_time FROM users WHERE user_id = ?", (user_id,))
    res = c.fetchone()
    if not res:
        c.execute("INSERT INTO users (user_id) VALUES (?)", (user_id,))
        conn.commit()
        res = (200, None)
    conn.close()
    return res

def get_accounts(user_id):
    conn = sqlite3.connect('bot_data.db')
    c = conn.cursor()
    c.execute("SELECT phone FROM accounts WHERE user_id = ?", (user_id,))
    res = [row[0] for row in c.fetchall()]
    conn.close()
    return res

# Command Handlers
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [InlineKeyboardButton("➕ Add Account", callback_data='add_account'),
         InlineKeyboardButton("📜 List Accounts", callback_data='list_accounts')],
        [InlineKeyboardButton("🕒 Set Delay", callback_data='set_delay'),
         InlineKeyboardButton("📅 Schedule", callback_data='set_schedule')],
        [InlineKeyboardButton("🚀 Start Messaging", callback_data='start_messaging'),
         InlineKeyboardButton("🛑 Stop", callback_data='stop_messaging')],
        [InlineKeyboardButton("🚪 Logout", callback_data='logout')]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    welcome_text = (
        "👋 *Welcome to WhatsApp Multi-Account Manager!*\n\n"
        "This bot helps you link multiple WhatsApp accounts and automate messaging between them safely.\n\n"
        "✨ *Features:*\n"
        "• Link via Pairing Code (No QR needed)\n"
        "• Anti-Ban Delays (200-300s default)\n"
        "• IST Scheduling\n"
        "• Two-way automated messaging\n\n"
        "Use the buttons below to get started!"
    )
    await update.message.reply_text(welcome_text, reply_markup=reply_markup, parse_mode='Markdown')

async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    if query.data == 'add_account':
        await query.edit_message_text("📱 Please send the phone number with country code (e.g., +919876543210):")
        context.user_data['state'] = 'AWAITING_PHONE'
        
    elif query.data == 'list_accounts':
        accounts = get_accounts(query.from_user.id)
        if not accounts:
            await query.edit_message_text("❌ No accounts linked yet.")
        else:
            text = "✅ *Linked Accounts:*\n" + "\n".join([f"• {a}" for a in accounts])
            await query.edit_message_text(text, parse_mode='Markdown')
            
    elif query.data == 'set_delay':
        delay, _ = get_user_config(query.from_user.id)
        await query.edit_message_text(f"⏱ Current delay: {delay}s\nSend a new value (min 200s):")
        context.user_data['state'] = 'AWAITING_DELAY'

    elif query.data == 'set_schedule':
        _, schedule = get_user_config(query.from_user.id)
        await query.edit_message_text(f"📅 Current schedule: {schedule or 'Not set'}\nSend time in HH:MM (IST, 24h format):")
        context.user_data['state'] = 'AWAITING_SCHEDULE'

    elif query.data == 'start_messaging':
        # Logic to start background thread for messaging
        await query.edit_message_text("🚀 Messaging process started in background!")
        
    elif query.data == 'stop_messaging':
        await query.edit_message_text("🛑 Messaging process stopped.")

async def message_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    state = context.user_data.get('state')
    user_id = update.effective_user.id
    text = update.message.text

    if state == 'AWAITING_PHONE':
        # Here we would trigger the Selenium pairing process
        await update.message.reply_text(f"⏳ Initializing WhatsApp Web for {text}...\nGenerating pairing code...")
        # Mocking code generation for now
        pairing_code = "ABCD-1234" 
        await update.message.reply_text(f"🔑 Your Pairing Code: `{pairing_code}`\n\nEnter this on your phone in WhatsApp > Linked Devices > Link with Phone Number.", parse_mode='Markdown')
        
        # Save to DB
        conn = sqlite3.connect('bot_data.db')
        c = conn.cursor()
        c.execute("INSERT INTO accounts (user_id, phone) VALUES (?, ?)", (user_id, text))
        conn.commit()
        conn.close()
        context.user_data['state'] = None

    elif state == 'AWAITING_DELAY':
        try:
            val = int(text)
            if val < 200:
                await update.message.reply_text("⚠️ Minimum delay is 200s for safety.")
                return
            conn = sqlite3.connect('bot_data.db')
            c = conn.cursor()
            c.execute("UPDATE users SET delay = ? WHERE user_id = ?", (val, user_id))
            conn.commit()
            conn.close()
            await update.message.reply_text(f"✅ Delay updated to {val}s.")
            context.user_data['state'] = None
        except ValueError:
            await update.message.reply_text("❌ Please send a valid number.")

    elif state == 'AWAITING_SCHEDULE':
        # Validate HH:MM
        try:
            datetime.strptime(text, "%H:%M")
            conn = sqlite3.connect('bot_data.db')
            c = conn.cursor()
            c.execute("UPDATE users SET schedule_time = ? WHERE user_id = ?", (text, user_id))
            conn.commit()
            conn.close()
            await update.message.reply_text(f"✅ Schedule set for {text} IST.")
            context.user_data['state'] = None
        except ValueError:
            await update.message.reply_text("❌ Invalid format. Use HH:MM (e.g., 14:30).")

if __name__ == '__main__':
    if not TOKEN:
        print("Error: TELEGRAM_BOT_TOKEN not found in environment.")
        exit(1)
        
    app = ApplicationBuilder().token(TOKEN).build()
    
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(button_handler))
    app.add_handler(MessageHandler(filters.TEXT & (~filters.COMMAND), message_handler))
    
    print("Bot is running...")
    app.run_polling()
