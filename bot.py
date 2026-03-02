import os
import time
import random
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, MessageHandler, filters
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from webdriver_manager.chrome import ChromeDriverManager
import schedule
import threading

# Environment variables
TELEGRAM_TOKEN = os.environ.get('TELEGRAM_TOKEN')

# WhatsApp Web URL
WA_WEB_URL = 'https://web.whatsapp.com/'

# Delay between messages (seconds)
delay = 300

# Linked accounts
linked_accounts = {}

# Messages to send
messages = [
    'Hello!',
    'How are you?',
    'This is a test message.',
    'WhatsApp Web is awesome!',
    'I can send messages now!',
    'Random message 1',
    'Random message 2',
    'Random message 3',
    'Random message 4',
    'Random message 5'
]

# Function to create WhatsApp Web driver
def create_driver():
    options = Options()
    options.add_argument('--headless')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    driver = webdriver.Chrome(options=options, executable_path=ChromeDriverManager().install())
    return driver

# Function to link WhatsApp account
async def link_account(update: Update, context: ContextTypes.DEFAULT_TYPE):
    phone_number = update.message.text.split(' ')[1]
    driver = create_driver()
    driver.get(WA_WEB_URL)
    # Wait for QR code to load
    WebDriverWait(driver, 60).until(EC.presence_of_element_located((By.XPATH, '//canvas')))
    # Get pairing code
    pairing_code = driver.find_element(By.XPATH, '//div[@class="_2UwZ_"]').text
    linked_accounts[update.effective_user.id] = {'driver': driver, 'phone_number': phone_number}
    await update.message.reply_text(f'Pairing code: {pairing_code}')

# Function to send message
async def send_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id in linked_accounts:
        driver = linked_accounts[user_id]['driver']
        phone_number = linked_accounts[user_id]['phone_number']
        message = random.choice(messages)
        # Send message
        driver.get(f'https://web.whatsapp.com/send?phone={phone_number}&text={message}')
        # Wait for message to send
        WebDriverWait(driver, 60).until(EC.presence_of_element_located((By.XPATH, '//span[@data-testid="send"]')))
        await update.message.reply_text(f'Message sent to {phone_number}')
    else:
        await update.message.reply_text('No linked accounts found.')

# Function to schedule message
async def schedule_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id in linked_accounts:
        schedule.every(delay).seconds.do(send_message, update, context)
        await update.message.reply_text(f'Message scheduled every {delay} seconds')
    else:
        await update.message.reply_text('No linked accounts found.')

# Function to start messaging
async def start_messaging(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id in linked_accounts:
        # Start messaging loop
        while True:
            schedule.run_pending()
            time.sleep(1)
    else:
        await update.message.reply_text('No linked accounts found.')

# Function to stop messaging
async def stop_messaging(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id in linked_accounts:
        # Stop messaging loop
        schedule.clear()
        await update.message.reply_text('Messaging stopped')
    else:
        await update.message.reply_text('No linked accounts found.')

# Function to set delay
async def set_delay(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global delay
    delay = int(update.message.text.split(' ')[1])
    await update.message.reply_text(f'Delay set to {delay} seconds')

# Function to list linked accounts
async def list_accounts(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id in linked_accounts:
        await update.message.reply_text(f'Linked accounts: {linked_accounts[user_id]["phone_number"]}')
    else:
        await update.message.reply_text('No linked accounts found.')

# Function to add account
async def add_account(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await link_account(update, context)

# Function to start bot
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text('Welcome to WhatsApp Bridge Bot!')

# Create bot application
application = ApplicationBuilder().token(TELEGRAM_TOKEN).build()

# Add handlers
application.add_handler(CommandHandler('start', start))
application.add_handler(CommandHandler('link', link_account))
application.add_handler(CommandHandler('send', send_message))
application.add_handler(CommandHandler('schedule', schedule_message))
application.add_handler(CommandHandler('start_messaging', start_messaging))
application.add_handler(CommandHandler('stop_messaging', stop_messaging))
application.add_handler(CommandHandler('set_delay', set_delay))
application.add_handler(CommandHandler('list_accounts', list_accounts))
application.add_handler(CommandHandler('add_account', add_account))

# Run bot
if __name__ == '__main__':
    application.run_polling()
