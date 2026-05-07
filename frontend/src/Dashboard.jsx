import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const socket = io(import.meta.env.VITE_API_URL || 'http://localhost:3001');

export default function Dashboard() {
  const [orders, setOrders] = useState([]);
  const [connected, setConnected] = useState(false);
  const audioCtxRef = useRef(null);

  useEffect(() => {
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('new_order', (order) => {
      setOrders(prev => [order, ...prev]);
      playAlert();
    });
    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('new_order');
    };
  }, []);

  const playAlert = () => {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.5);
      gain.gain.setValueAtTime(1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) { console.error(e); }
  };

  return (
    <div className="min-h-screen p-8 bg-slate-950">
      <header className="flex items-center justify-between pb-6 mb-8 border-b border-slate-800">
        <h1 className="text-3xl font-bold text-blue-500">Baze Campus Kiosk</h1>
        <div className="flex items-center gap-2 px-4 py-2 font-semibold rounded-full bg-slate-900">
          <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500 shadow-[0_0_10px_#22c55e]' : 'bg-red-500'} animate-pulse`}></div>
          {connected ? 'System Online' : 'Connecting...'}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {orders.length === 0 ? (
          <div className="col-span-full py-20 text-center text-slate-500 text-xl">Waiting for new orders...</div>
        ) : (
          orders.map((order) => (
            <div key={order.id} className="p-6 transition-all border-2 border-transparent bg-slate-900 rounded-2xl hover:border-blue-500/50 group">
              <div className="flex items-center justify-between mb-4">
                <span className="text-xl font-bold text-yellow-500">#{order.id.toString().slice(-4)}</span>
                <span className="text-sm text-slate-400">{new Date(order.time).toLocaleTimeString()}</span>
              </div>
              <div className="mb-4 text-lg font-medium text-slate-200">{order.item}</div>
              <div className="p-3 mb-6 font-mono text-sm rounded bg-black/30 text-slate-400">
                Customer: {order.customer}
              </div>
              <button 
                onClick={() => setOrders(prev => prev.filter(o => o.id !== order.id))}
                className="w-full py-4 font-bold text-white transition-opacity bg-green-600 rounded-xl hover:opacity-90"
              >
                Ready to Deliver
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}











