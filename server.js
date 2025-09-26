const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

class PixelBattleServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        
        this.players = new Map();
        this.pixels = new Map();
        this.leaderboard = [];
        
        this.setupExpress();
        this.loadPixels();
        this.setupWebSocket();
        this.startIntervals();
    }
    
    setupExpress() {
        this.app.use(express.static(path.join(__dirname, 'public')));
        this.app.use(express.json());
        
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });
        
        this.app.get('/api/status', (req, res) => {
            res.json({
                status: 'online',
                players: this.players.size,
                pixels: this.pixels.size,
                leaderboard: this.leaderboard.slice(0, 10)
            });
        });
        
        this.app.get('/api/pixels', (req, res) => {
            const pixels = {};
            this.pixels.forEach((value, key) => {
                pixels[key] = value;
            });
            res.json(pixels);
        });
    }
    
    setupWebSocket() {
        this.wss.on('connection', (ws, req) => {
            console.log('Новый игрок подключился');
            
            // Отправляем текущее состояние
            this.sendInitialData(ws);
            
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(ws, message);
                } catch (error) {
                    console.error('Ошибка парсинга сообщения:', error);
                }
            });
            
            ws.on('close', () => {
                this.handleDisconnect(ws);
            });
            
            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
            });
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
            case 'updateColor':
                this.handleUpdateColor(ws, message);
                break;
            case 'useDynamite':
                this.handleUseDynamite(ws, message);
                break;
            case 'playerStats':
                this.handlePlayerStats(ws, message);
                break;
        }
    }
    
    handlePlayerJoin(ws, message) {
        const player = {
            ws: ws,
            id: message.playerId,
            username: message.username || `Игрок${Math.floor(Math.random() * 1000)}`,
            tokens: message.tokens || 0,
            level: message.level || 1,
            energy: message.energy || 100,
            color: message.color || '#ff4444',
            joinTime: Date.now(),
            lastActive: Date.now()
        };
        
        this.players.set(message.playerId, player);
        console.log(`Игрок ${player.username} присоединился`);
        
        this.updateLeaderboard();
        this.broadcastPlayerList();
        this.broadcastLeaderboard();
    }
    
    handlePlacePixel(ws, message) {
        const player = this.players.get(message.playerId);
        if (!player || player.energy <= 0) return;
        
        const { x, y, color } = message;
        if (x < 0 || x >= 250 || y < 0 || y >= 250) return;
        
        const pixelId = `${x},${y}`;
        this.pixels.set(pixelId, {
            x, y, color,
            playerId: message.playerId,
            playerName: player.username,
            timestamp: Date.now()
        });
        
        // Обновляем статистику игрока
        player.tokens += 0.1;
        player.energy -= 1;
        player.level = Math.floor(player.tokens / 100) + 1;
        player.lastActive = Date.now();
        
        // Сохраняем пиксели
        this.savePixels();
        
        // Рассылаем обновление
        this.broadcast({
            type: 'pixelPlaced',
            pixelId: pixelId,
            x: x,
            y: y,
            color: color,
            playerId: message.playerId,
            playerName: player.username
        });
        
        // Отправляем обновление статистики игроку
        this.sendToPlayer(message.playerId, {
            type: 'playerStats',
            tokens: player.tokens,
            level: player.level,
            energy: player.energy
        });
        
        this.updateLeaderboard();
        this.broadcastLeaderboard();
    }
    
    handleUpdateColor(ws, message) {
        const player = this.players.get(message.playerId);
        if (player) {
            player.color = message.color;
            player.lastActive = Date.now();
            
            this.broadcast({
                type: 'playerColorUpdate',
                playerId: message.playerId,
                color: message.color,
                username: player.username
            });
        }
    }
    
    handleUseDynamite(ws, message) {
        const player = this.players.get(message.playerId);
        if (!player || player.tokens < 100) return;
        
        player.tokens -= 100;
        player.lastActive = Date.now();
        
        // Удаляем все пиксели игрока
        this.pixels.forEach((pixel, pixelId) => {
            if (pixel.playerId === message.playerId) {
                this.pixels.delete(pixelId);
            }
        });
        
        this.savePixels();
        
        this.broadcast({
            type: 'pixelsReset',
            playerId: message.playerId,
            playerName: player.username
        });
        
        this.sendToPlayer(message.playerId, {
            type: 'playerStats',
            tokens: player.tokens,
            level: player.level,
            energy: player.energy
        });
        
        this.updateLeaderboard();
        this.broadcastLeaderboard();
    }
    
    handlePlayerStats(ws, message) {
        const player = this.players.get(message.playerId);
        if (player) {
            player.tokens = message.tokens;
            player.level = message.level;
            player.energy = message.energy;
            player.lastActive = Date.now();
            
            this.updateLeaderboard();
            this.broadcastLeaderboard();
        }
    }
    
    handleDisconnect(ws) {
        for (let [playerId, player] of this.players) {
            if (player.ws === ws) {
                this.players.delete(playerId);
                console.log(`Игрок ${player.username} отключился`);
                break;
            }
        }
        this.updateLeaderboard();
        this.broadcastPlayerList();
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
            leaderboard: this.leaderboard,
            topThree: this.leaderboard.slice(0, 3)
        }));
    }
    
    sendToPlayer(playerId, message) {
        const player = this.players.get(playerId);
        if (player && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    }
    
    broadcast(message) {
        const messageStr = JSON.stringify(message);
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(messageStr);
            }
        });
    }
    
    broadcastPlayerList() {
        const players = {};
        this.players.forEach((player, playerId) => {
            players[playerId] = {
                username: player.username,
                tokens: player.tokens,
                level: player.level,
                color: player.color
            };
        });
        
        this.broadcast({
            type: 'playerList',
            players: players,
            onlineCount: this.players.size
        });
    }
    
    broadcastLeaderboard() {
        this.broadcast({
            type: 'leaderboard',
            leaderboard: this.leaderboard,
            topThree: this.leaderboard.slice(0, 3),
            timestamp: Date.now()
        });
    }
    
    updateLeaderboard() {
        this.leaderboard = Array.from(this.players.values())
            .map(player => ({
                id: player.id,
                username: player.username,
                tokens: player.tokens,
                level: player.level,
                color: player.color
            }))
            .sort((a, b) => b.tokens - a.tokens)
            .slice(0, 100);
    }
    
    loadPixels() {
        try {
            if (fs.existsSync('pixels.json')) {
                const data = fs.readFileSync('pixels.json', 'utf8');
                const pixelsData = JSON.parse(data);
                for (let pixelId in pixelsData) {
                    this.pixels.set(pixelId, pixelsData[pixelId]);
                }
                console.log(`Загружено ${this.pixels.size} пикселей`);
            }
        } catch (error) {
            console.error('Ошибка загрузки пикселей:', error);
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
            console.error('Ошибка сохранения пикселей:', error);
        }
    }
    
    startIntervals() {
        // Автосохранение каждые 30 секунд
        setInterval(() => {
            this.savePixels();
        }, 30000);
        
        // Восстановление энергии каждые 30 секунд
        setInterval(() => {
            const now = Date.now();
            this.players.forEach((player) => {
                if (player.energy < 100 && now - player.lastActive < 300000) {
                    player.energy = Math.min(100, player.energy + 10);
                    this.sendToPlayer(player.id, {
                        type: 'energyUpdate',
                        energy: player.energy
                    });
                }
            });
        }, 30000);
        
        // Очистка неактивных игроков (5 минут)
        setInterval(() => {
            const now = Date.now();
            for (let [playerId, player] of this.players) {
                if (now - player.lastActive > 300000) {
                    this.players.delete(playerId);
                    console.log(`Удален неактивный игрок: ${player.username}`);
                }
            }
        }, 60000);
    }
    
    start(port = process.env.PORT || 3000) {
        this.server.listen(port, '0.0.0.0', () => {
            console.log('🎮 Pixel Battle Server запущен!');
            console.log(`📍 Порт: ${port}`);
            console.log(`🌐 Окружение: ${process.env.NODE_ENV || 'development'}`);
            console.log(`📊 Статус: http://localhost:${port}/api/status`);
        });
    }
}

// Запуск сервера
const server = new PixelBattleServer();
server.start();
