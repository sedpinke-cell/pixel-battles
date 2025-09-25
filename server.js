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
        // Указываем правильный путь для статических файлов на Render.com
        const staticPath = path.join(__dirname, 'public');
        console.log('Serving static files from:', staticPath);
        
        this.app.use(express.static(staticPath));
        
        this.app.get('/', (req, res) => {
            const indexPath = path.join(__dirname, 'public', 'index.html');
            console.log('Serving index.html from:', indexPath);
            
            // Проверяем существование файла
            if (fs.existsSync(indexPath)) {
                res.sendFile(indexPath);
            } else {
                // Если файла нет, отправляем простую HTML страницу
                console.log('index.html not found, sending fallback');
                res.send(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Pixel Battle</title>
                        <meta http-equiv="refresh" content="2;url=/">
                    </head>
                    <body>
                        <h1>Pixel Battle Server is running!</h1>
                        <p>Redirecting to game...</p>
                        <script>
                            setTimeout(() => window.location.href = '/', 2000);
                        </script>
                    </body>
                    </html>
                `);
            }
        });
        
        this.app.get('/api/status', (req, res) => {
            res.json({
                status: 'online',
                players: this.players.size,
                pixels: this.pixels.size,
                mapSize: '250x250',
                timestamp: Date.now()
            });
        });
        
        // Fallback для SPA
        this.app.get('*', (req, res) => {
            const indexPath = path.join(__dirname, 'public', 'index.html');
            if (fs.existsSync(indexPath)) {
                res.sendFile(indexPath);
            } else {
                res.status(404).json({ error: 'Not found' });
            }
        });
    }
    
    initServer() {
        this.server = http.createServer(this.app);
        
        this.wss = new WebSocket.Server({ 
            server: this.server,
            clientTracking: true
        });
        
        this.wss.on('connection', (ws, req) => {
            console.log('New client connected from:', req.socket.remoteAddress);
            
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
            
            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
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
            case 'pong':
                // Обработка pong для поддержания соединения
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
            username: message.username || `Player${Math.floor(Math.random() * 1000)}`,
            ip: message.ip || 'unknown'
        };
        
        this.players.set(message.playerId, player);
        console.log(`Player ${player.username} joined (IP: ${player.ip})`);
        
        // Отправляем приветственное сообщение
        this.sendToPlayer(ws, {
            type: 'welcome',
            message: `Добро пожаловать в Pixel Battle, ${player.username}!`,
            playerId: player.id
        });
        
        this.broadcastPlayers();
        this.broadcastLeaderboard();
    }
    
    handlePlacePixel(ws, message) {
        const { x, y, color, playerId, pixelId } = message;
        
        if (x < 0 || x >= 250 || y < 0 || y >= 250) {
            console.log('Invalid pixel coordinates:', x, y);
            return;
        }
        
        const player = this.players.get(playerId);
        if (!player) {
            console.log('Player not found:', playerId);
            return;
        }
        
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
            pixelId, x, y, color: pixelColor, 
            playerId: player.id,
            playerName: player.username
        });
        
        this.broadcastLeaderboard();
        this.savePixels();
        
        console.log(`Pixel placed by ${player.username} at ${x},${y}`);
    }
    
    handleUseDynamite(ws, message) {
        const player = this.players.get(message.playerId);
        if (!player || player.tokens < 100) {
            console.log('Dynamite failed for player:', message.playerId);
            return;
        }
        
        player.tokens -= 100;
        let removedCount = 0;
        
        for (let [pixelId, pixel] of this.pixels) {
            if (pixel.playerId === message.playerId) {
                this.pixels.delete(pixelId);
                removedCount++;
            }
        }
        
        this.broadcast({ 
            type: 'pixelsReset', 
            playerId: message.playerId,
            playerName: player.username,
            removedCount: removedCount
        });
        
        this.broadcastLeaderboard();
        this.savePixels();
        
        console.log(`Dynamite used by ${player.username}, removed ${removedCount} pixels`);
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
                
                this.broadcastPlayers();
                this.broadcastLeaderboard();
                break;
            }
        }
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
        
        const initialData = {
            type: 'initialData',
            pixels: pixels,
            players: players,
            mapSize: { width: 250, height: 250 },
            message: 'Добро пожаловать в Pixel Battle!',
            serverTime: Date.now()
        };
        
        this.sendToPlayer(ws, initialData);
    }
    
    sendToPlayer(ws, message) {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(message));
            } catch (error) {
                console.error('Error sending message to player:', error);
            }
        }
    }
    
    broadcast(message) {
        const messageString = JSON.stringify(message);
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(messageString);
                } catch (error) {
                    console.error('Error broadcasting message:', error);
                }
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
            onlineCount: this.players.size,
            timestamp: Date.now()
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
            const pixelsPath = path.join(__dirname, 'pixels.json');
            if (fs.existsSync(pixelsPath)) {
                const data = fs.readFileSync(pixelsPath, 'utf8');
                const pixelsData = JSON.parse(data);
                for (let pixelId in pixelsData) {
                    this.pixels.set(pixelId, pixelsData[pixelId]);
                }
                console.log(`Loaded ${this.pixels.size} pixels from ${pixelsPath}`);
            } else {
                console.log('No existing pixels file found, starting fresh');
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
            
            const pixelsPath = path.join(__dirname, 'pixels.json');
            fs.writeFileSync(pixelsPath, JSON.stringify(pixelsObject, null, 2));
            console.log(`Saved ${this.pixels.size} pixels to ${pixelsPath}`);
        } catch (error) {
            console.error('Error saving pixels:', error);
        }
    }
    
    startCleanupInterval() {
        // Очистка неактивных игроков каждые 5 минут
        setInterval(() => {
            const now = Date.now();
            let removedCount = 0;
            
            for (let [playerId, player] of this.players) {
                if (now - player.lastActive > 300000) { // 5 минут
                    this.players.delete(playerId);
                    removedCount++;
                    console.log(`Removed inactive player: ${player.username}`);
                }
            }
            
            if (removedCount > 0) {
                this.broadcastPlayers();
                this.broadcastLeaderboard();
            }
        }, 300000);
        
        // Автосохранение пикселей каждые 30 секунд
        setInterval(() => {
            this.savePixels();
        }, 30000);
        
        // Ping клиентов каждые 30 секунд для поддержания соединения
        setInterval(() => {
            this.broadcast({ type: 'ping', timestamp: Date.now() });
        }, 30000);
    }
    
    start(port = process.env.PORT || 3000) {
        this.server.listen(port, '0.0.0.0', () => {
            console.log('🎮 Pixel Battle Server started!');
            console.log(`📍 Port: ${port}`);
            console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`📁 Working directory: ${__dirname}`);
            console.log(`📊 Loaded: ${this.pixels.size} pixels, ${this.players.size} players`);
        });
    }
}

// Создаем и запускаем сервер
const server = new PixelServer();
server.start();
