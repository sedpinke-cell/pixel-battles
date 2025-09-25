const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

class PixelServer {
    constructor() {
        this.players = new Map();
        this.pixels = new Map();
        this.app = express();
        this.server = null;
        this.wss = null;
        
        this.setupExpress();
        this.loadPixels();
        this.initServer();
        this.startCleanupInterval();
    }
    
    setupExpress() {
        // Правильная настройка статических файлов
        this.app.use(express.static(path.join(__dirname)));
        
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });
        
        this.app.get('/api/status', (req, res) => {
            res.json({
                status: 'online',
                players: this.players.size,
                pixels: this.pixels.size,
                mapSize: '250x250'
            });
        });
        
        // Добавьте fallback для SPA
        this.app.get('*', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });
    }
    
    initServer() {
        this.server = http.createServer(this.app);
        
        this.wss = new WebSocket.Server({ 
            server: this.server,
            clientTracking: true
        });
        
        this.wss.on('connection', (ws, req) => {
            console.log('New client connected');
            
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(ws, message);
                } catch (error) {
                    console.error('Error parsing message:', error);
                }
            });
            
            ws.on('close', () => {
                this.handleDisconnect(ws);
            });
            
            this.sendInitialData(ws);
        });
    }
    
    handleMessage(ws, message) {
        switch (message.type) {
            case 'join':
                this.handlePlayerJoin(ws, message);
                break;
            case 'placePixel':
                this.handlePlacePixel(ws, message);
                break;
            case 'useDynamite':
                this.handleUseDynamite(ws, message);
                break;
            case 'updatePlayer':
                this.handleUpdatePlayer(ws, message);
                break;
            case 'updateColor':
                this.handleUpdateColor(ws, message);
                break;
        }
    }
    
    handlePlayerJoin(ws, message) {
        const player = {
            id: message.playerId,
            ws: ws,
            tokens: message.tokens || 0,
            level: message.level || 1,
            color: message.color || '#ff4444',
            lastActive: Date.now(),
            username: message.username || `Player${Math.floor(Math.random() * 1000)}`
        };
        
        this.players.set(message.playerId, player);
        console.log(`Player ${player.username} joined`);
        
        this.broadcastPlayers();
        this.broadcastLeaderboard();
    }
    
    handlePlacePixel(ws, message) {
        const { x, y, color, playerId, pixelId } = message;
        
        if (x < 0 || x >= 250 || y < 0 || y >= 250) return;
        
        const player = this.players.get(playerId);
        if (!player) return;
        
        const pixelColor = player.color;
        
        this.pixels.set(pixelId, {
            x, y, color: pixelColor, playerId,
            playerName: player.username,
            timestamp: Date.now()
        });
        
        player.tokens += 0.050;
        player.level = Math.min(Math.floor(player.tokens / 1) + 1, 20);
        player.lastActive = Date.now();
        
        this.broadcast({
            type: 'pixelUpdate',
            pixelId, x, y, color: pixelColor, playerId,
            playerName: player.username
        });
        
        this.broadcastLeaderboard();
        this.savePixels();
    }
    
    handleUseDynamite(ws, message) {
        const player = this.players.get(message.playerId);
        if (!player || player.tokens < 100) return;
        
        player.tokens -= 100;
        
        for (let [pixelId, pixel] of this.pixels) {
            if (pixel.playerId === message.playerId) {
                this.pixels.delete(pixelId);
            }
        }
        
        this.broadcast({ 
            type: 'pixelsReset', 
            playerId: message.playerId,
            playerName: player.username
        });
        this.broadcastLeaderboard();
        this.savePixels();
    }
    
    handleUpdatePlayer(ws, message) {
        const player = this.players.get(message.playerId);
        if (player) {
            player.tokens = message.tokens;
            player.level = message.level;
            player.lastActive = Date.now();
            this.broadcastLeaderboard();
        }
    }
    
    handleUpdateColor(ws, message) {
        const player = this.players.get(message.playerId);
        if (player) {
            player.color = message.color;
            player.lastActive = Date.now();
            
            this.broadcast({
                type: 'playerColorUpdate',
                playerId: message.playerId,
                color: message.color
            });
            
            this.broadcastLeaderboard();
        }
    }
    
    handleDisconnect(ws) {
        for (let [playerId, player] of this.players) {
            if (player.ws === ws) {
                this.players.delete(playerId);
                console.log(`Player ${player.username} disconnected`);
                
                this.broadcast({
                    type: 'playerLeft',
                    playerId: playerId,
                    playerName: player.username
                });
                break;
            }
        }
        this.broadcastPlayers();
        this.broadcastLeaderboard();
    }
    
    sendInitialData(ws) {
        const pixels = {};
        this.pixels.forEach((pixel, pixelId) => {
            pixels[pixelId] = pixel;
        });
        
        const players = {};
        this.players.forEach((player, playerId) => {
            players[playerId] = {
                id: playerId,
                username: player.username,
                tokens: player.tokens,
                level: player.level,
                color: player.color
            };
        });
        
        ws.send(JSON.stringify({
            type: 'initialData',
            pixels: pixels,
            players: players,
            mapSize: { width: 250, height: 250 },
            message: 'Добро пожаловать в Pixel Battle!'
        }));
    }
    
    broadcast(message) {
        const messageString = JSON.stringify(message);
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(messageString);
            }
        });
    }
    
    broadcastPlayers() {
        const players = {};
        this.players.forEach((player, playerId) => {
            players[playerId] = {
                id: playerId,
                username: player.username,
                tokens: player.tokens,
                level: player.level,
                color: player.color
            };
        });
        
        this.broadcast({
            type: 'playersUpdate',
            players: players,
            onlineCount: this.players.size
        });
    }
    
    broadcastLeaderboard() {
        const playersArray = Array.from(this.players.values())
            .map(player => ({
                id: player.id,
                username: player.username,
                tokens: player.tokens,
                level: player.level,
                color: player.color
            }))
            .sort((a, b) => b.tokens - a.tokens);
        
        const leaderboard = {};
        playersArray.forEach((player, index) => {
            leaderboard[player.id] = { ...player, rank: index + 1 };
        });
        
        this.broadcast({
            type: 'leaderboard',
            players: leaderboard,
            timestamp: Date.now()
        });
    }
    
    loadPixels() {
        try {
            if (fs.existsSync('pixels.json')) {
                const data = fs.readFileSync('pixels.json', 'utf8');
                const pixelsData = JSON.parse(data);
                for (let pixelId in pixelsData) {
                    this.pixels.set(pixelId, pixelsData[pixelId]);
                }
                console.log(`Loaded ${this.pixels.size} pixels`);
            }
        } catch (error) {
            console.error('Error loading pixels:', error);
        }
    }
    
    savePixels() {
        try {
            const pixelsObject = {};
            this.pixels.forEach((pixel, pixelId) => {
                pixelsObject[pixelId] = pixel;
            });
            fs.writeFileSync('pixels.json', JSON.stringify(pixelsObject, null, 2));
        } catch (error) {
            console.error('Error saving pixels:', error);
        }
    }
    
    startCleanupInterval() {
        setInterval(() => {
            const now = Date.now();
            for (let [playerId, player] of this.players) {
                if (now - player.lastActive > 300000) {
                    this.players.delete(playerId);
                    console.log(`Removed inactive player: ${player.username}`);
                }
            }
        }, 300000);
        
        setInterval(() => this.savePixels(), 30000);
    }
    
    start(port = process.env.PORT || 3000) {
        this.server.listen(port, '0.0.0.0', () => {
            console.log('🎮 Pixel Battle Server started!');
            console.log(`📍 Port: ${port}`);
            console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`📁 Static files from: ${path.join(__dirname, 'public')}`);
        });
    }
}

const server = new PixelServer();
server.start();
