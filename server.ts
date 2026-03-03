import express from "express";
import { createServer as createViteServer } from "vite";
import { Telegraf, Markup, Context } from "telegraf";
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    WA_DEFAULT_EPHEMERAL
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import Database from "better-sqlite3";
import cron from "node-cron";
import fs from "fs";
import path from "path";

// --- Configuration & Initialization ---
const PORT = 3000;
const db = new Database("bot_data.db");
const logger = pino({ level: "silent" });
const OWNER_USERNAME = "@indiawsagent";
const OWNER_ID = "6729390752";

// --- Database Setup ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY,
    delay_seconds INTEGER DEFAULT 250,
    is_running INTEGER DEFAULT 0,
    is_authorized INTEGER DEFAULT 0,
    is_admin INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT,
    phone_number TEXT,
    session_id TEXT UNIQUE,
    is_connected INTEGER DEFAULT 0,
    is_new_link INTEGER DEFAULT 1,
    FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
  );

  CREATE TABLE IF NOT EXISTS schedules (
    telegram_id TEXT PRIMARY KEY,
    cron_time TEXT,
    is_active INTEGER DEFAULT 0,
    FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
  );
`);

// Migration: Add columns if they don't exist
try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all() as any[];
    
    const hasDelayColumn = tableInfo.some(col => col.name === 'delay_seconds');
    if (!hasDelayColumn) {
        db.exec("ALTER TABLE users ADD COLUMN delay_seconds INTEGER DEFAULT 250");
        console.log("Migration: Added delay_seconds column to users table");
    }

    const hasRunningColumn = tableInfo.some(col => col.name === 'is_running');
    if (!hasRunningColumn) {
        db.exec("ALTER TABLE users ADD COLUMN is_running INTEGER DEFAULT 0");
        console.log("Migration: Added is_running column to users table");
    }

    const hasStepColumn = tableInfo.some(col => col.name === 'current_step');
    if (!hasStepColumn) {
        db.exec("ALTER TABLE users ADD COLUMN current_step INTEGER DEFAULT 0");
        console.log("Migration: Added current_step column to users table");
    }

    const hasAuthColumn = tableInfo.some(col => col.name === 'is_authorized');
    if (!hasAuthColumn) {
        db.exec("ALTER TABLE users ADD COLUMN is_authorized INTEGER DEFAULT 0");
        console.log("Migration: Added is_authorized column to users table");
    }

    const hasAdminColumn = tableInfo.some(col => col.name === 'is_admin');
    if (!hasAdminColumn) {
        db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0");
        console.log("Migration: Added is_admin column to users table");
    }

    const sessionTableInfo = db.prepare("PRAGMA table_info(whatsapp_sessions)").all() as any[];
    const hasNewLinkColumn = sessionTableInfo.some(col => col.name === 'is_new_link');
    if (!hasNewLinkColumn) {
        db.exec("ALTER TABLE whatsapp_sessions ADD COLUMN is_new_link INTEGER DEFAULT 1");
        console.log("Migration: Added is_new_link column to whatsapp_sessions table");
    }
} catch (e) {
    console.error("Migration error:", e);
}

// --- WhatsApp Session Management ---
const sessions = new Map<string, any>();

async function connectToWhatsApp(telegramId: string, phoneNumber: string, bot: Telegraf<Context>) {
    const cleanNumber = phoneNumber.replace(/\D/g, '');
    const sessionId = `session_${telegramId}_${cleanNumber}`;
    const authPath = path.join(process.cwd(), 'sessions', sessionId);
    
    // Close existing session if any
    const existingSock = sessions.get(sessionId);
    if (existingSock) {
        try {
            existingSock.ev.removeAllListeners('connection.update');
            existingSock.ev.removeAllListeners('creds.update');
            existingSock.end(new Error("New connection starting"));
        } catch (e) {}
        sessions.delete(sessionId);
    }

    if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Connecting session ${sessionId} using WA v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
    });

    sessions.set(sessionId, sock);

    sock.ev.on('creds.update', saveCreds);

    let pairingCodeRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401;
            
            console.log(`Connection closed for ${phoneNumber}. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
            
            // Mark as disconnected in DB for status view
            db.prepare("UPDATE whatsapp_sessions SET is_connected = 0 WHERE session_id = ?").run(sessionId);

            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(telegramId, phoneNumber, bot), 5000);
            } else {
                // Permanent disconnect (Logout or Banned)
                db.prepare("DELETE FROM whatsapp_sessions WHERE session_id = ?").run(sessionId);
                sessions.delete(sessionId);
                
                const authPath = path.join(process.cwd(), 'sessions', sessionId);
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                }

                await bot.telegram.sendMessage(telegramId, `⚠️ *Account Disconnected:* ${phoneNumber}\n\nThis account has been logged out or the session has expired. It has been removed from your list.`, { parse_mode: 'Markdown' });
            }
        } else if (connection === 'open') {
            console.log(`Opened connection for ${phoneNumber}`);
            const session = db.prepare("SELECT is_new_link FROM whatsapp_sessions WHERE session_id = ?").get(sessionId) as any;
            if (session && session.is_new_link === 1) {
                await bot.telegram.sendMessage(telegramId, `✅ WhatsApp account ${phoneNumber} connected successfully!`);
                db.prepare("UPDATE whatsapp_sessions SET is_new_link = 0 WHERE session_id = ?").run(sessionId);
            }
            db.prepare("UPDATE whatsapp_sessions SET is_connected = 1 WHERE session_id = ?").run(sessionId);
        }
    });

    // Handle pairing code if not connected
    if (!sock.authState.creds.registered && !pairingCodeRequested) {
        pairingCodeRequested = true;
        
        setTimeout(async () => {
            try {
                const num = phoneNumber.replace(/\D/g, '');
                console.log(`[Session ${sessionId}] Requesting pairing code for ${num}...`);
                
                if (sessions.get(sessionId) !== sock) return;

                const code = await sock.requestPairingCode(num);
                await bot.telegram.sendMessage(telegramId, `🔑 Your pairing code for ${phoneNumber} is:\n\n*${code}*\n\nPlease enter this in your WhatsApp (Settings > Linked Devices > Link with phone number).`, { parse_mode: 'Markdown' });
            } catch (err: any) {
                console.error(`[Session ${sessionId}] Error requesting pairing code:`, err.message || err);
                pairingCodeRequested = false; 
                await bot.telegram.sendMessage(telegramId, `❌ Failed to get pairing code for ${phoneNumber}: ${err.message || 'Unknown error'}`);
            }
        }, 10000); // 10s delay is safer for international pairing
    }

    return sock;
}

// --- Telegram Bot Logic ---
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
    console.warn("TELEGRAM_BOT_TOKEN is not set. Bot will not start.");
}

const bot = new Telegraf(botToken || "DUMMY_TOKEN");

// Global error handler
bot.catch((err: any, ctx) => {
    console.error(`Ooops, encountered an error for ${ctx.updateType}`, err.message || err);
});

// Middleware to ensure user exists in DB and check authorization
bot.use(async (ctx, next) => {
    if (ctx.from) {
        const telegramId = ctx.from.id.toString();
        let user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) as any;
        
        if (!user) {
            // Check if this is the owner or the very first user
            const userCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as any).count;
            const isAdmin = (telegramId === OWNER_ID || userCount === 0) ? 1 : 0;
            const isAuth = (telegramId === OWNER_ID || userCount === 0) ? 1 : 0;
            
            db.prepare("INSERT INTO users (telegram_id, is_admin, is_authorized) VALUES (?, ?, ?)").run(telegramId, isAdmin, isAuth);
            user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);
        } else if (telegramId === OWNER_ID && !user.is_admin) {
            // Ensure owner is always admin
            db.prepare("UPDATE users SET is_admin = 1, is_authorized = 1 WHERE telegram_id = ?").run(telegramId);
            user.is_admin = 1;
            user.is_authorized = 1;
        }

        // Allow admins to use everything
        if (user.is_admin) return next();

        // Check if authorized
        if (!user.is_authorized) {
            // Only allow /start for unauthorized users
            if (ctx.message && 'text' in ctx.message && ctx.message.text === '/start') {
                return next();
            }
            
            return ctx.reply(`🚫 *Access Denied*\n\nYou do not have access to use this bot. Please contact the owner ${OWNER_USERNAME} to request access.\n\nYour Telegram ID: \`${telegramId}\``, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    Markup.button.url('👤 Contact Owner', `https://t.me/${OWNER_USERNAME.replace('@', '')}`)
                ])
            });
        }
    }
    return next();
});

const getMainMenu = (isAdmin: boolean) => {
    const buttons = [
        ['📱 Add Account', '📋 List Accounts'],
        ['🚀 Start Messaging', '🛑 Stop'],
        ['📅 Schedule', '⏳ Set Delay'],
        ['🚪 Logout All']
    ];
    if (isAdmin) {
        buttons.push(['🔑 Admin Panel']);
    }
    return Markup.keyboard(buttons).resize();
};

bot.start((ctx) => {
    const telegramId = ctx.from.id.toString();
    const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) as any;
    ctx.reply("👋 Welcome to the WhatsApp Account Linker!\n\nUse the buttons below to link your WhatsApp accounts using pairing codes.", getMainMenu(user?.is_admin === 1));
});

bot.hears('📱 Add Account', (ctx) => {
    ctx.reply("Please send the phone number you want to link, including the country code (e.g., 919876543210).");
});

bot.hears('⏳ Set Delay', (ctx) => {
    ctx.reply("Please enter the delay between messages in seconds.\n\n⚠️ *Safety Tip:* WhatsApp often bans accounts with low delays. We recommend *200-300 seconds* for maximum safety.", { parse_mode: 'Markdown' });
});

bot.on('text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    const telegramId = ctx.from.id.toString();

    // Check if it's a delay setting (1-4 digits)
    if (/^\d{1,4}$/.test(text)) {
        const delay = parseInt(text);
        if (delay < 10) return ctx.reply("❌ Delay too short! Minimum 10 seconds for safety.");
        
        db.prepare("UPDATE users SET delay_seconds = ? WHERE telegram_id = ?").run(delay, telegramId);
        return ctx.reply(`✅ Delay updated to ${delay} seconds. This will take effect from the next message.`);
    }

    // Check if it's a phone number (10-15 digits)
    if (/^(\+?\d{10,15})$/.test(text)) {
        const phoneNumber = text;
        const cleanNumber = phoneNumber.replace(/\D/g, '');
        const sessionId = `session_${telegramId}_${cleanNumber}`;
        
        const authPath = path.join(process.cwd(), 'sessions', sessionId);
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }

        const existing = db.prepare("SELECT * FROM whatsapp_sessions WHERE session_id = ?").get(sessionId);
        if (!existing) {
            db.prepare("INSERT INTO whatsapp_sessions (telegram_id, phone_number, session_id, is_new_link) VALUES (?, ?, ?, 1)").run(telegramId, phoneNumber, sessionId);
        } else {
            db.prepare("UPDATE whatsapp_sessions SET is_new_link = 1 WHERE session_id = ?").run(sessionId);
        }
        
        ctx.reply(`⏳ Requesting a fresh pairing code for ${phoneNumber}...\n\nMake sure to enter the code exactly as shown.`);
        await connectToWhatsApp(telegramId, phoneNumber, bot);
        return;
    }

    return next();
});

bot.hears('📋 List Accounts', (ctx) => {
    const accounts = db.prepare("SELECT * FROM whatsapp_sessions WHERE telegram_id = ?").all(ctx.from.id.toString()) as any[];
    if (accounts.length === 0) {
        return ctx.reply("No accounts linked yet.");
    }
    
    accounts.forEach((acc) => {
        const status = acc.is_connected ? '✅ Connected' : '❌ Disconnected';
        ctx.reply(`📱 *Account:* ${acc.phone_number}\n*Status:* ${status}`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.callback('🗑️ Delete Account', `delete_${acc.session_id}`)
            ])
        });
    });
});

bot.hears('🚀 Start Messaging', async (ctx) => {
    const telegramId = ctx.from.id.toString();
    const accounts = db.prepare("SELECT * FROM whatsapp_sessions WHERE telegram_id = ? AND is_connected = 1").all(telegramId) as any[];
    
    if (accounts.length < 2) {
        return ctx.reply("❌ You need at least 2 connected accounts for two-way messaging.");
    }
    
    const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) as any;
    db.prepare("UPDATE users SET is_running = 1 WHERE telegram_id = ?").run(telegramId);
    ctx.reply(`🚀 Automated messaging started!\n\n⏱️ Current Delay: ${user.delay_seconds}s (+ random jitter)\n🛡️ Anti-ban: Enabled (Typing simulation & randomized timing)`);
    
    startMessagingLoop(telegramId);
});

bot.hears('🛑 Stop', (ctx) => {
    const telegramId = ctx.from.id.toString();
    db.prepare("UPDATE users SET is_running = 0 WHERE telegram_id = ?").run(telegramId);
    db.prepare("UPDATE schedules SET is_active = 0 WHERE telegram_id = ?").run(telegramId);
    ctx.reply("🛑 All messaging (manual and scheduled) has been stopped.");
});

bot.hears('📅 Schedule', (ctx) => {
    ctx.reply("📅 *Set Messaging Schedule (IST)*\n\nPlease enter the time range in 24-hour format (e.g., `09:00-18:00`).\n\nThe bot will automatically start messaging during this period and stop outside of it.", { parse_mode: 'Markdown' });
});

bot.hears(/^(\d{2}:\d{2}-\d{2}:\d{2})$/, (ctx) => {
    const range = ctx.message.text;
    const telegramId = ctx.from.id.toString();
    
    db.prepare("INSERT OR REPLACE INTO schedules (telegram_id, cron_time, is_active) VALUES (?, ?, 1)").run(telegramId, range);
    ctx.reply(`✅ Schedule set: *${range}* (IST).\n\nBot will now follow this schedule automatically. You can still use 'Start Messaging' to override it manually.`, { parse_mode: 'Markdown' });
    
    // Trigger the loop check immediately
    startMessagingLoop(telegramId);
});

// --- Admin Commands ---
bot.hears(/^access grant (\d+)$/, (ctx) => {
    const adminId = ctx.from.id.toString();
    const admin = db.prepare("SELECT * FROM users WHERE telegram_id = ? AND is_admin = 1").get(adminId);
    if (!admin) return;

    const targetId = ctx.match[1];
    db.prepare("UPDATE users SET is_authorized = 1 WHERE telegram_id = ?").run(targetId);
    ctx.reply(`✅ Access granted to user ID: ${targetId}`);
    bot.telegram.sendMessage(targetId, "🎉 Your access has been granted! You can now use the bot.").catch(() => {});
});

bot.hears(/^access remove (\d+)$/, (ctx) => {
    const adminId = ctx.from.id.toString();
    const admin = db.prepare("SELECT * FROM users WHERE telegram_id = ? AND is_admin = 1").get(adminId);
    if (!admin) return;

    const targetId = ctx.match[1];
    db.prepare("UPDATE users SET is_authorized = 0 WHERE telegram_id = ?").run(targetId);
    ctx.reply(`❌ Access removed from user ID: ${targetId}`);
    bot.telegram.sendMessage(targetId, "🚫 Your access has been revoked by the admin.").catch(() => {});
});

bot.hears('access list', (ctx) => {
    const adminId = ctx.from.id.toString();
    const admin = db.prepare("SELECT * FROM users WHERE telegram_id = ? AND is_admin = 1").get(adminId);
    if (!admin) return;

    const authorizedUsers = db.prepare("SELECT * FROM users WHERE is_authorized = 1").all() as any[];
    if (authorizedUsers.length === 0) {
        return ctx.reply("No authorized users found.");
    }

    let list = "👥 *Authorized Users:*\n\n";
    authorizedUsers.forEach(u => {
        list += `• ID: \`${u.telegram_id}\` ${u.is_admin ? '(Admin)' : ''}\n`;
    });
    ctx.reply(list, { parse_mode: 'Markdown' });
});

bot.action(/^delete_(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const telegramId = ctx.from!.id.toString();
    
    const acc = db.prepare("SELECT * FROM whatsapp_sessions WHERE session_id = ? AND telegram_id = ?").get(sessionId, telegramId) as any;
    if (!acc) return ctx.answerCbQuery("Account not found.");

    const sock = sessions.get(sessionId);
    if (sock) {
        try { await sock.logout(); } catch (e) {}
        sessions.delete(sessionId);
    }

    const authPath = path.join(process.cwd(), 'sessions', sessionId);
    if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
    }

    db.prepare("DELETE FROM whatsapp_sessions WHERE session_id = ?").run(sessionId);
    await ctx.editMessageText(`🗑️ Account ${acc.phone_number} has been deleted and session cleared.`);
    ctx.answerCbQuery();
});

bot.hears('🔑 Admin Panel', (ctx) => {
    const adminId = ctx.from.id.toString();
    const admin = db.prepare("SELECT * FROM users WHERE telegram_id = ? AND is_admin = 1").get(adminId);
    if (!admin) return;

    ctx.reply("🔑 *Admin Panel*\n\nUse the following commands to manage access:\n\n" +
              "• `access grant [ID]` - Grant access to a user\n" +
              "• `access remove [ID]` - Remove access from a user\n" +
              "• `access list` - List all authorized users\n\n" +
              "Example: `access grant 123456789`", { parse_mode: 'Markdown' });
});

bot.hears('🚪 Logout All', async (ctx) => {
    const telegramId = ctx.from.id.toString();
    const accounts = db.prepare("SELECT * FROM whatsapp_sessions WHERE telegram_id = ?").all(telegramId) as any[];
    
    for (const acc of accounts) {
        const sock = sessions.get(acc.session_id);
        if (sock) {
            try { await sock.logout(); } catch (e) {}
        }
        const authPath = path.join(process.cwd(), 'sessions', acc.session_id);
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
    }
    
    db.prepare("DELETE FROM whatsapp_sessions WHERE telegram_id = ?").run(telegramId);
    ctx.reply("👋 All accounts logged out and sessions cleared.");
});

// --- Messaging Logic ---
const randomMessages = [
    "Hello! How are you doing today?",
    "Just checking in, hope you're having a great day!",
    "Hey, what's up?",
    "Did you see the news today?",
    "I'm testing this automated system, looks cool!",
    "Let's catch up soon!",
    "Have a wonderful afternoon!",
    "Everything good on your end?",
    "Just a quick ping!",
    "Hope you're busy with something productive!"
];

function isWithinTimeRange(rangeStr: string): boolean {
    if (!rangeStr) return true;
    try {
        const [start, end] = rangeStr.split('-');
        const now = new Date();
        const ist = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
        const currentMinutes = ist.getHours() * 60 + ist.getMinutes();
        
        const [startH, startM] = start.split(':').map(Number);
        const [endH, endM] = end.split(':').map(Number);
        
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;
        
        if (startMinutes <= endMinutes) {
            return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
        } else {
            // Overlap midnight
            return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
        }
    } catch (e) {
        return true;
    }
}

const activeTimeouts = new Map<string, NodeJS.Timeout>();

async function startMessagingLoop(telegramId: string) {
    // Clear any existing timeout for this user to prevent duplicate loops
    if (activeTimeouts.has(telegramId)) {
        clearTimeout(activeTimeouts.get(telegramId));
        activeTimeouts.delete(telegramId);
    }

    const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) as any;
    if (!user) return;

    const schedule = db.prepare("SELECT * FROM schedules WHERE telegram_id = ? AND is_active = 1").get(telegramId) as any;
    const range = schedule ? schedule.cron_time : null;

    // Logic: Run if manually started OR if scheduled and within range
    const isManual = user.is_running === 1;
    const isScheduledActive = schedule && isWithinTimeRange(range);

    if (!isManual && !isScheduledActive) {
        if (schedule) {
            console.log(`[User ${telegramId}] Outside schedule range (${range}). Waiting...`);
            // Check again in 5 minutes if scheduled but outside range
            const timeout = setTimeout(() => startMessagingLoop(telegramId), 300000);
            activeTimeouts.set(telegramId, timeout);
        }
        return;
    }

    const accounts = db.prepare("SELECT * FROM whatsapp_sessions WHERE telegram_id = ? AND is_connected = 1").all(telegramId) as any[];
    if (accounts.length < 2) {
        console.log(`[User ${telegramId}] Less than 2 connected accounts. Stopping loop.`);
        db.prepare("UPDATE users SET is_running = 0 WHERE telegram_id = ?").run(telegramId);
        return;
    }

    const step = user.current_step || 0;

    // Alternating two-way messaging
    const senderIdx = step % accounts.length;
    const receiverIdx = (step + 1) % accounts.length;

    const sender = accounts[senderIdx];
    const receiver = accounts[receiverIdx];

    const senderSock = sessions.get(sender.session_id);
    if (senderSock) {
        const msg = randomMessages[Math.floor(Math.random() * randomMessages.length)];
        try {
            const jid = receiver.phone_number.replace(/\D/g, '') + '@s.whatsapp.net';
            
            // Anti-ban: Simulate typing for a few seconds
            await senderSock.sendPresenceUpdate('composing', jid);
            await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 4000));
            await senderSock.sendPresenceUpdate('paused', jid);

            await senderSock.sendMessage(jid, { text: msg });
            console.log(`[User ${telegramId}][Step ${step}] Sent from ${sender.phone_number} to ${receiver.phone_number}`);
            
            // Increment step in DB only after successful send
            db.prepare("UPDATE users SET current_step = ? WHERE telegram_id = ?").run(step + 1, telegramId);
        } catch (err) {
            console.error(`Error sending from ${sender.phone_number}:`, err);
            // Even on error, we might want to increment step to try the other account next time
            db.prepare("UPDATE users SET current_step = ? WHERE telegram_id = ?").run(step + 1, telegramId);
        }
    } else {
        // If sender is not available, increment step to try next account
        db.prepare("UPDATE users SET current_step = ? WHERE telegram_id = ?").run(step + 1, telegramId);
    }

    // Anti-ban: Add random jitter (±20% of the base delay)
    const baseDelay = user.delay_seconds || 250;
    const jitter = (Math.random() * 0.4 - 0.2) * baseDelay; 
    const finalDelay = Math.max(10, (baseDelay + jitter)) * 1000;
    
    console.log(`[User ${telegramId}] Next message in ${Math.round(finalDelay/1000)}s`);
    const nextTimeout = setTimeout(() => startMessagingLoop(telegramId), finalDelay);
    activeTimeouts.set(telegramId, nextTimeout);
}

// --- Cron Jobs for Schedules ---
// Check every 5 minutes for scheduled tasks that should start
cron.schedule('*/5 * * * *', () => {
    const activeSchedules = db.prepare("SELECT * FROM schedules WHERE is_active = 1").all() as any[];
    activeSchedules.forEach(sched => {
        if (isWithinTimeRange(sched.cron_time)) {
            startMessagingLoop(sched.telegram_id);
        }
    });
});

// --- Express Server Setup ---
async function startServer() {
    const app = express();

    app.get("/api/status", (req, res) => {
        const stats = {
            users: db.prepare("SELECT COUNT(*) as count FROM users").get() as any,
            sessions: db.prepare("SELECT COUNT(*) as count FROM whatsapp_sessions").get() as any,
            connected: db.prepare("SELECT COUNT(*) as count FROM whatsapp_sessions WHERE is_connected = 1").get() as any,
        };
        res.json(stats);
    });

    app.post("/api/add-account", express.json(), async (req, res) => {
        const { telegramId, phoneNumber } = req.body;
        if (!telegramId || !phoneNumber) {
            return res.status(400).json({ error: "Missing telegramId or phoneNumber" });
        }

        try {
            const cleanNumber = phoneNumber.replace(/\D/g, '');
            const sessionId = `session_${telegramId}_${cleanNumber}`;
            
            const existing = db.prepare("SELECT * FROM whatsapp_sessions WHERE session_id = ?").get(sessionId);
            if (!existing) {
                db.prepare("INSERT INTO whatsapp_sessions (telegram_id, phone_number, session_id, is_new_link) VALUES (?, ?, ?, 1)").run(telegramId, phoneNumber, sessionId);
            } else {
                db.prepare("UPDATE whatsapp_sessions SET is_new_link = 1 WHERE session_id = ?").run(sessionId);
            }

            // Ensure user exists
            const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId.toString());
            if (!user) {
                db.prepare("INSERT INTO users (telegram_id) VALUES (?)").run(telegramId.toString());
            }

            connectToWhatsApp(telegramId.toString(), phoneNumber, bot);
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    if (process.env.NODE_ENV !== "production") {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: "spa",
        });
        app.use(vite.middlewares);
    } else {
        app.use(express.static("dist"));
    }

    app.listen(PORT, "0.0.0.0", async () => {
        console.log(`Server running on http://localhost:${PORT}`);
        if (botToken && botToken !== "DUMMY_TOKEN") {
            try {
                // Clear any existing webhooks or polling sessions to prevent 409 Conflict
                await bot.telegram.deleteWebhook({ drop_pending_updates: true });
                
                await bot.launch();
                console.log("Telegram Bot started");
            } catch (err: any) {
                console.error("Failed to launch Telegram Bot:", err.message);
            }
        }
    });
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

startServer();

// Reconnect existing sessions on startup
const existingSessions = db.prepare("SELECT * FROM whatsapp_sessions").all() as any[];
existingSessions.forEach(acc => {
    connectToWhatsApp(acc.telegram_id, acc.phone_number, bot);
});
