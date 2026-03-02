import os
import time
import random
import json
import logging
import asyncio
from datetime import datetime
import pytz
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, CallbackQueryHandler, MessageHandler, filters
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# Logging
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# Config
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
IST = pytz.timezone('Asia/Kolkata')
ACCOUNTS_FILE = "accounts.json"

# State Storage
user_data = {} # Stores temporary states like phone numbers during linking
scheduler = AsyncIOScheduler(timezone=IST)
scheduler.start()

def load_accounts():
    if os.path.exists(ACCOUNTS_FILE):
        with open(ACCOUNTS_FILE, "r") as f: return json.load(f)
    return {}

def save_accounts(data):
    with open(ACCOUNTS_FILE, "w") as f: json.dump(data, f)

# --- Browser Logic ---
def get_driver(account_id):
    options = Options()
    options.add_argument("--headless") # Required for hosting
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    # Separate profile for each account
    profile_path = os.path.join(os.getcwd(), "profiles", f"account_{account_id}")
    options.add_argument(f"--user-data-dir={profile_path}")
    
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    return driver

async def link_account_logic(update: Update, context: ContextTypes.DEFAULT_TYPE, phone: str):
    account_id = str(random.randint(1000, 9999))
    driver = get_driver(account_id)
    driver.get("https://web.whatsapp.com")
    
    try:
        # Click "Link with phone number instead"
        wait = WebDriverWait(driver, 30)
        link_btn = wait.until(EC.element_to_be_clickable((By.XPATH, "//*[contains(text(), 'Link with phone number')]")))
        link_btn.click()
        
        # Input phone number
        phone_input = wait.until(EC.presence_of_element_located((By.XPATH, "//input[@type='text']")))
        phone_input.send_keys(phone)
        
        next_btn = driver.find_element(By.XPATH, "//*[contains(text(), 'Next')]")
        next_btn.click()
        
        # Scrape 8-digit code
        code_elements = wait.until(EC.presence_of_all_elements_located((By.XPATH, "//div[@aria-details='pairing-code']//span")))
        pairing_code = "".join([el.text for el in code_elements])
        
        await update.message.reply_text(f"✅ Code Generated!\nEnter this on your phone: `{pairing_code}`", parse_mode="Markdown")
        
        # Save account reference
        accounts = load_accounts()
        accounts[account_id] = {"phone": phone, "linked": False, "delay": 250}
        save_accounts(accounts)
        
    except Exception as e:
        await update.message.reply_text(f"❌ Error during linking: {str(e)}")
    finally:
        driver.quit()

# --- Telegram Bot Handlers ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [InlineKeyboardButton("➕ Add Account", callback_query_data="add")],
        [InlineKeyboardButton("📜 List Accounts", callback_query_data="list")],
        [InlineKeyboardButton("⚙️ Schedule & Delay", callback_query_data="settings")],
        [InlineKeyboardButton("🚀 Start Messaging", callback_query_data="start_msg"), InlineKeyboardButton("🛑 Stop", callback_query_data="stop")]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text("👋 *Welcome to Multi-WA Bot*\nLink your accounts using pairing codes and schedule automated 2-way messaging.", reply_markup=reply_markup, parse_mode="Markdown")

async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    if query.data == "add":
        await query.message.reply_text("Please send your phone number with country code (e.g., +919876543210):")
        context.user_data['state'] = 'awaiting_phone'
    elif query.data == "list":
        accounts = load_accounts()
        text = "Linked Accounts:\n" + "\n".join([f"ID: {id} | {acc['phone']}" for id, acc in accounts.items()])
        await query.message.reply_text(text or "No accounts linked.")

async def message_received(update: Update, context: ContextTypes.DEFAULT_TYPE):
    state = context.user_data.get('state')
    if state == 'awaiting_phone':
        phone = update.message.text
        await update.message.reply_text(f"⏳ Opening WhatsApp Web for {phone}...")
        asyncio.create_task(link_account_logic(update, context, phone))
        context.user_data['state'] = None

# --- Main Logic Execution ---
if __name__ == "__main__":
    app = ApplicationBuilder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(button_handler))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, message_received))
    app.run_polling()
