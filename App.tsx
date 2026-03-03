import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Bot, Users, MessageSquare, ShieldCheck, Clock, Plus, Smartphone, Send, AlertCircle, CheckCircle2 } from 'lucide-react';

export default function App() {
  const [stats, setStats] = useState({ users: 0, sessions: 0, connected: 0 });
  const [telegramId, setTelegramId] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        setStats({
          users: data.users.count,
          sessions: data.sessions.count,
          connected: data.connected.count
        });
      } catch (err) {
        console.error("Failed to fetch stats", err);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!telegramId || !phoneNumber) return;
    
    setLoading(true);
    setMessage(null);
    
    try {
      const res = await fetch('/api/add-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramId, phoneNumber }),
      });
      
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: 'Pairing request sent! Check your Telegram bot for the code.' });
        setPhoneNumber('');
      } else {
        setMessage({ type: 'error', text: data.error || 'Failed to add account' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Network error. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-emerald-500/30">
      {/* Background Glow */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-500/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 blur-[120px] rounded-full" />
      </div>

      <main className="relative z-10 max-w-5xl mx-auto px-6 py-12">
        <motion.header 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center text-center mb-16"
        >
          <div className="w-16 h-16 bg-emerald-500/20 rounded-2xl flex items-center justify-center mb-6 border border-emerald-500/30">
            <Bot className="w-8 h-8 text-emerald-400" />
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-4 bg-clip-text text-transparent bg-gradient-to-b from-white to-white/60">
            WhatsApp Multi-Bot
          </h1>
          <p className="text-white/40 text-lg max-w-2xl">
            A powerful Telegram-integrated manager for automated, safe, and scheduled messaging between multiple WhatsApp accounts.
          </p>
        </motion.header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <StatCard 
            icon={<Users className="w-5 h-5" />} 
            label="Active Users" 
            value={stats.users} 
            color="emerald"
          />
          <StatCard 
            icon={<MessageSquare className="w-5 h-5" />} 
            label="Total Sessions" 
            value={stats.sessions} 
            color="blue"
          />
          <StatCard 
            icon={<ShieldCheck className="w-5 h-5" />} 
            label="Connected Now" 
            value={stats.connected} 
            color="purple"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-12">
          <motion.section 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-white/5 border border-white/10 rounded-3xl p-8 backdrop-blur-xl"
          >
            <h2 className="text-2xl font-semibold mb-6 flex items-center gap-3">
              <Plus className="w-6 h-6 text-emerald-400" />
              Link New Account
            </h2>
            
            <form onSubmit={handleAddAccount} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-white/40 mb-2 uppercase tracking-wider">Telegram ID</label>
                <div className="relative">
                  <Users className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/20" />
                  <input 
                    type="text" 
                    value={telegramId}
                    onChange={(e) => setTelegramId(e.target.value)}
                    placeholder="Enter your Telegram ID"
                    className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-12 pr-4 focus:outline-none focus:border-emerald-500/50 transition-all"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-white/40 mb-2 uppercase tracking-wider">Phone Number</label>
                <div className="relative">
                  <Smartphone className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/20" />
                  <input 
                    type="text" 
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="e.g. 919876543210"
                    className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-12 pr-4 focus:outline-none focus:border-emerald-500/50 transition-all"
                    required
                  />
                </div>
              </div>

              <button 
                type="submit"
                disabled={loading}
                className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:hover:bg-emerald-500 text-black font-bold py-4 rounded-2xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-500/20"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                ) : (
                  <>
                    <Send className="w-5 h-5" />
                    Request Pairing Code
                  </>
                )}
              </button>

              <AnimatePresence>
                {message && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className={`p-4 rounded-2xl flex items-start gap-3 ${
                      message.type === 'success' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
                    }`}
                  >
                    {message.type === 'success' ? <CheckCircle2 className="w-5 h-5 shrink-0" /> : <AlertCircle className="w-5 h-5 shrink-0" />}
                    <p className="text-sm font-medium">{message.text}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </form>
          </motion.section>

          <motion.section 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 }}
            className="bg-white/5 border border-white/10 rounded-3xl p-8 backdrop-blur-xl"
          >
            <h2 className="text-2xl font-semibold mb-6 flex items-center gap-3">
              <Clock className="w-6 h-6 text-emerald-400" />
              System Info
            </h2>
            
            <div className="space-y-6">
              <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
                <div>
                  <p className="font-medium">Telegram Bot</p>
                  <p className="text-sm text-white/40">Listening for commands</p>
                </div>
                <div className="flex items-center gap-2 px-3 py-1 bg-emerald-500/20 border border-emerald-500/30 rounded-full">
                  <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
                  <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Online</span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <div className="p-6 bg-white/5 rounded-2xl border border-white/5">
                  <h3 className="text-sm font-semibold text-white/40 uppercase tracking-widest mb-2">Setup Instructions</h3>
                  <ul className="text-sm space-y-2 text-white/70">
                    <li>1. Set <code className="bg-white/10 px-1 rounded text-emerald-400">TELEGRAM_BOT_TOKEN</code> in Secrets</li>
                    <li>2. Start the bot on Telegram</li>
                    <li>3. Use <code className="bg-white/10 px-1 rounded text-emerald-400">/start</code> to begin</li>
                    <li>4. Add accounts via pairing codes</li>
                  </ul>
                </div>
                <div className="p-6 bg-white/5 rounded-2xl border border-white/5">
                  <h3 className="text-sm font-semibold text-white/40 uppercase tracking-widest mb-2">Safety Features</h3>
                  <ul className="text-sm space-y-2 text-white/70">
                    <li>• Adjustable 200-300s delays</li>
                    <li>• Randomized message content</li>
                    <li>• Two-way alternating traffic</li>
                    <li>• IST-based daily scheduling</li>
                  </ul>
                </div>
              </div>
            </div>
          </motion.section>
        </div>

        <footer className="mt-16 text-center text-white/20 text-sm">
          Built with Node.js, Baileys, and Telegraf.
        </footer>
      </main>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: any, label: string, value: number, color: string }) {
  const colors: any = {
    emerald: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    blue: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    purple: 'text-purple-400 bg-purple-500/10 border-purple-500/20'
  };

  return (
    <motion.div 
      whileHover={{ y: -5 }}
      className={`p-6 rounded-3xl border ${colors[color]} backdrop-blur-sm transition-all`}
    >
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-xl bg-white/5">
          {icon}
        </div>
        <span className="text-sm font-semibold uppercase tracking-wider opacity-60">{label}</span>
      </div>
      <div className="text-4xl font-bold tracking-tighter">{value}</div>
    </motion.div>
  );
}
