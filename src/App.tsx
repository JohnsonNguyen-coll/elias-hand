import React, { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { 
  Zap, 
  Terminal as TerminalIcon, 
  Play, 
  Square, 
  Settings, 
  Wallet, 
  Activity,
  ShieldCheck,
  Server,
  Cpu,
  RefreshCw,
  Lock,
  Unlock
} from 'lucide-react';
import { MintBot } from './logic/mintBot';
import type { BotConfig, LogMessage } from './logic/mintBot';

const NETWORKS = [
  { name: 'Ethereum (Alchemy)', url: `https://eth-mainnet.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_KEY || ''}` },
  { name: 'Ethereum (Cloudflare)', url: 'https://cloudflare-eth.com' },
  { name: 'BSC (Binance)', url: 'https://bsc-dataseed.binance.org/' },
  { name: 'Base (Official)', url: 'https://mainnet.base.org' },
  { name: 'Polygon (Official)', url: 'https://polygon-rpc.com' },
  { name: 'Arbitrum (Official)', url: 'https://arb1.arbitrum.io/rpc' },
  { name: 'Custom RPC', url: '' }
];

// MẬT KHẨU TRUY CẬP (Đọc từ .env)
const ACCESS_PASSWORD = import.meta.env.VITE_ACCESS_PASSWORD || 'admin';

function App() {
  const [unlocked, setUnlocked] = useState(false);
  const [passInput, setPassInput] = useState('');
  
  const [config, setConfig] = useState<Omit<BotConfig, 'privateKey'>>({
    rpcUrl: NETWORKS[0].url,
    contractAddress: '',
    functionName: 'mintSeaDrop',
    args: [],
    mode: 'instant',
    maxPriorityFee: '2',
    mintValue: '0',
    mintType: 'seadrop',
    quantity: 1
  });

  const privateKeyRef = useRef('');
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [isBotRunning, setIsBotRunning] = useState(false);
  const [stats, setStats] = useState({ gas: 0, block: 0, latency: 0 });
  const botRef = useRef<MintBot | null>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Fetch real stats from RPC
  useEffect(() => {
    if (!config.rpcUrl || !unlocked) return;

    const fetchStats = async () => {
      try {
        const start = Date.now();
        const provider = new ethers.JsonRpcProvider(config.rpcUrl);
        const [block, feeData] = await Promise.all([
          provider.getBlockNumber(),
          provider.getFeeData()
        ]);
        
        const gasGwei = feeData.gasPrice ? Number(ethers.formatUnits(feeData.gasPrice, 'gwei')).toFixed(1) : '0';
        const latency = Date.now() - start;

        setStats({
          gas: Number(gasGwei),
          block: block,
          latency: latency
        });
      } catch (err) {
        console.error("Failed to fetch stats", err);
      }
    };

    fetchStats();
    const itv = setInterval(fetchStats, 10000); // Update every 10s
    return () => clearInterval(itv);
  }, [config.rpcUrl, unlocked]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = (log: LogMessage) => {
    setLogs(prev => [...prev.slice(-99), log]);
  };

  const handleStart = async () => {
    if (!config.rpcUrl) {
      addLog({ timestamp: new Date().toLocaleTimeString(), message: 'Vui lòng nhập Custom RPC URL!', type: 'error' });
      return;
    }

    if (!privateKeyRef.current || !config.contractAddress) {
      addLog({ timestamp: new Date().toLocaleTimeString(), message: 'Vui lòng nhập đầy đủ thông tin (Private Key & Contract)!', type: 'error' });
      return;
    }

    setIsBotRunning(true);
    const fullConfig: BotConfig = { ...config, privateKey: privateKeyRef.current };
    botRef.current = new MintBot(fullConfig, addLog);
    
    try {
      await botRef.current.start(fullConfig);
    } catch (err: any) {
      addLog({ timestamp: new Date().toLocaleTimeString(), message: err.message, type: 'error' });
    } finally {
      setIsBotRunning(false);
    }
  };

  const handleStop = () => {
    botRef.current?.stop();
    setIsBotRunning(false);
  };

  if (!unlocked) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="card" style={{ width: 350, textAlign: 'center' }}>
          <div className="title" style={{ justifyContent: 'center', marginBottom: 24 }}>
            <Lock size={32} className="text-blue-500" />
            <span style={{ fontSize: 24 }}>ELIAS BOT</span>
          </div>
          <label className="label">Mật khẩu truy cập</label>
          <input 
            type="password" 
            className="input" 
            style={{ textAlign: 'center', fontSize: 18, letterSpacing: 4 }}
            placeholder="••••••"
            value={passInput}
            onChange={(e) => setPassInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && passInput === ACCESS_PASSWORD && setUnlocked(true)}
          />
          <button 
            className="btn btn-primary" 
            style={{ marginTop: 20 }}
            onClick={() => passInput === ACCESS_PASSWORD ? setUnlocked(true) : alert('Sai mật khẩu!')}
          >
            MỞ KHÓA HỆ THỐNG
          </button>
          <div style={{ marginTop: 20, fontSize: 10, color: '#4b5563' }}>
            SECURED ACCESS ONLY
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ animation: 'fadeIn 0.5s ease' }}>
      {/* Sidebar: Configuration */}
      <aside className="sidebar">
        <div className="title" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Zap size={24} className="text-blue-500" />
            <span>ELIAS BOT</span>
          </div>
          <button onClick={() => setUnlocked(false)} style={{ background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer' }}>
             <Unlock size={16} />
          </button>
        </div>

        <div className="section">
          <label className="label">Chế độ Mint</label>
          <select 
            className="input"
            value={config.mintType}
            onChange={(e) => setConfig({...config, mintType: e.target.value as any})}
          >
            <option value="seadrop">SeaDrop (OpenSea)</option>
            <option value="custom">Custom Contract (Direct)</option>
          </select>
        </div>

        <div className="section">
          <label className="label">Mạng / Chain</label>
          <select 
            className="input"
            value={NETWORKS.find(n => n.url === config.rpcUrl)?.url || ''}
            onChange={(e) => setConfig({...config, rpcUrl: e.target.value})}
          >
            {NETWORKS.map(n => <option key={n.name} value={n.url}>{n.name}</option>)}
          </select>
          {(!NETWORKS.some(n => n.url === config.rpcUrl) || config.rpcUrl === '') && (
            <input 
              type="text"
              className="input"
              style={{ marginTop: 8 }}
              placeholder="https://your-custom-rpc.com"
              value={config.rpcUrl}
              onChange={(e) => setConfig({...config, rpcUrl: e.target.value})}
            />
          )}
        </div>

        <div className="section">
          <label className="label">Private Key</label>
          <input 
            type="password"
            className="input"
            placeholder="0x..."
            onChange={(e) => { privateKeyRef.current = e.target.value }}
          />
        </div>

        <div className="section">
          <label className="label">Địa chỉ Contract NFT</label>
          <input 
            type="text"
            className="input"
            placeholder="0x..."
            value={config.contractAddress}
            onChange={(e) => setConfig({...config, contractAddress: e.target.value})}
          />
        </div>

        <div className="grid-2">
            <div className="section">
                <label className="label">Số lượng Mint</label>
                <input 
                    type="number"
                    className="input"
                    value={config.quantity}
                    onChange={(e) => setConfig({...config, quantity: Number(e.target.value)})}
                />
            </div>
            {config.mintType === 'custom' ? (
                <div className="section">
                    <label className="label">Giá Mint (ETH)</label>
                    <input 
                        type="text"
                        className="input"
                        placeholder="0.01"
                        value={config.mintValue}
                        onChange={(e) => setConfig({...config, mintValue: e.target.value})}
                    />
                </div>
            ) : (
                <div className="section">
                    <label className="label">Loại Contract</label>
                    <div className="input" style={{ opacity: 0.5, fontSize: 12 }}>Auto-Fetch Giá</div>
                </div>
            )}
        </div>

        {config.mintType === 'custom' && (
            <>
                <div className="section">
                    <label className="label">Tên hàm Mint</label>
                    <input 
                        type="text"
                        className="input"
                        placeholder="mint"
                        value={config.functionName}
                        onChange={(e) => setConfig({...config, functionName: e.target.value})}
                    />
                </div>

                <div className="section">
                    <label className="label">Tham số hàm (JSON array)</label>
                    <input 
                        type="text"
                        className="input"
                        placeholder='["0xAddress", 1]'
                        onChange={(e) => {
                           try {
                             const parsed = JSON.parse(e.target.value);
                             if (Array.isArray(parsed)) setConfig({...config, args: parsed});
                           } catch (e) {}
                        }}
                    />
                </div>
            </>
        )}

        <div className="section">
          <label className="label">Tiền Tip (Max Priority Fee - Gwei)</label>
          <input 
            type="number"
            className="input"
            placeholder="Ví dụ: 2"
            value={config.maxPriorityFee}
            onChange={(e) => setConfig({...config, maxPriorityFee: e.target.value})}
          />
          <span className="label" style={{ fontSize: 10, marginTop: 4, textTransform: 'none' }}>
            Tip cho thợ đào (EIP-1559). 2-5 nhanh, &gt;10 cực nhanh.
          </span>
        </div>

        <div className="section">
          <label className="label">Chế độ chạy</label>
          <div className="grid-2">
            <button 
              className={`btn ${config.mode === 'instant' ? 'btn-primary' : 'input'}`}
              onClick={() => setConfig({...config, mode: 'instant'})}
            >
              Mint Ngay
            </button>
            <button 
              className={`btn ${config.mode === 'snipe' ? 'btn-primary' : 'input'}`}
              onClick={() => setConfig({...config, mode: 'snipe'})}
            >
              Auto Snipe
            </button>
          </div>
        </div>

        <div style={{ marginTop: 'auto' }}>
          {!isBotRunning ? (
            <button className="btn btn-primary flex items-center justify-center gap-2" onClick={handleStart}>
               <Play size={18} /> BẮT ĐẦU CHẠY
            </button>
          ) : (
            <button className="btn btn-danger flex items-center justify-center gap-2" onClick={handleStop}>
               <Square size={18} /> DỪNG BOT
            </button>
          )}
        </div>
      </aside>

      {/* Main Content: Logs & Stats */}
      <main className="main-content">
        {/* Status Header */}
        <div className="grid-2" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="card">
            <div className="label">Trạng thái</div>
            <div className="flex items-center gap-2" style={{ fontWeight: 700 }}>
              <div className={`w-2 h-2 rounded-full ${isBotRunning ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} style={{ width: 8, height: 8, borderRadius: '50%' }} />
              {isBotRunning ? 'ĐANG CHẠY' : 'ĐANG DỪNG'}
            </div>
          </div>
          <div className="card">
            <div className="label">Gas Hiện Tại</div>
            <div style={{ fontWeight: 700 }}>{stats.gas} Gwei</div>
          </div>
          <div className="card">
            <div className="label">Block Mới Nhất</div>
            <div style={{ fontWeight: 700 }}>#{stats.block.toLocaleString()}</div>
          </div>
          <div className="card">
            <div className="label">Tốc độ Load</div>
            <div style={{ fontWeight: 700 }}>{stats.latency}ms</div>
          </div>
        </div>

        {/* Terminal Logs */}
        <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="title" style={{ fontSize: 14 }}>
            <TerminalIcon size={18} className="text-blue-500" />
            <span>CONSOLE OUTPUT</span>
            <span className="badge" style={{ marginLeft: 'auto' }}>{logs.length} ITEMS</span>
          </div>
          
          <div className="log-container">
            {logs.length === 0 && <div className="log-item" style={{ opacity: 0.5 }}>Chờ hành động từ người dùng...</div>}
            {logs.map((log, i) => (
              <div key={i} className={`log-item ${log.type === 'error' ? 'log-error' : log.type === 'success' ? 'log-success' : log.type === 'warning' ? 'log-warning' : ''}`}>
                <span style={{ color: '#4b5563' }}>[{log.timestamp}]</span> {log.message}
              </div>
            ))}
            <div ref={terminalEndRef} />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
