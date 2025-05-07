const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const axios = require('axios');
const NodeID3 = require('node-id3'); // For embedding metadata

const app = express();
const port = 3000;
const tempDir = path.join(__dirname, 'temp');

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console(),
  ],
});

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json());
app.use(express.static('public'));

// Create temp directory
fs.mkdir(tempDir, { recursive: true }).catch((err) =>
  logger.error('Error creating temp directory:', err.message)
);

// Execute yt-dlp with spawn
const execYtDlp = (args) => {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => (stdout += data));
    proc.stderr.on('data', (data) => (stderr += data));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || 'yt-dlp failed'));
      resolve(stdout);
    });
  });
};

// Download thumbnail image
const downloadThumbnail = async (url, filePath) => {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });
  const writer = require('fs').createWriteStream(filePath);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};

app.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ message: 'URL មិនត្រូវបានផ្តល់!' });
  }
  try {
    const stdout = await execYtDlp(['--dump-json', url]);
    const info = JSON.parse(stdout);
    if (!info.title || !info.thumbnail) {
      throw new Error('មិនអាចទាញ metadata បាន!');
    }
    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      artist: info.uploader || info.artist || 'Unknown Artist', // Fallback artist
    });
  } catch (error) {
    logger.error('Error fetching info:', { url, message: error.message });
    res.status(500).json({ message: `មិនអាចទាញព័ត៌មានបាន: ${error.message}` });
  }
});

app.post('/download', async (req, res) => {
  const { url, format, artist } = req.body;
  if (!url || !format) {
    return res.status(400).json({ message: 'URL ឬ format មិនត្រូវបានផ្តល់!' });
  }

  let responded = false;
  const sendError = (message) => {
    if (!responded) {
      responded = true;
      res.status(500).json({ message });
    }
  };

  const cleanup = async (files) => {
    for (const file of files) {
      try {
        if (await fs.access(file).then(() => true).catch(() => false)) {
          await fs.unlink(file);
          logger.info(`Deleted file: ${file}`);
        }
      } catch (err) {
        logger.error(`Error deleting file ${file}:`, err.message);
      }
    }
  };

  try {
    const stdout = await execYtDlp(['--dump-json', url]);
    const info = JSON.parse(stdout);
    const title = info.title.replace(/[^a-zA-Z0-9]/g, '_');
    const fileName = `${title}_${uuidv4()}.${format}`;
    const filePath = path.join(tempDir, fileName);
    const thumbnailPath = path.join(tempDir, `${title}_${uuidv4()}.jpg`);

    if (format === 'mp3') {
      // Download audio
      await execYtDlp(['-x', '--audio-format', 'mp3', '-o', filePath, url]);
      await fs.access(filePath);

      // Download thumbnail
      await downloadThumbnail(info.thumbnail, thumbnailPath);

      // Embed metadata
      const tags = {
        title: info.title,
        artist: artist || info.uploader || info.artist || 'Unknown Artist',
        image: thumbnailPath, // Embed thumbnail as album art
      };
      const success = NodeID3.write(tags, filePath);
      if (!success) {
        logger.warn('Failed to write ID3 tags', { filePath });
      }

      res.setHeader('Content-Disposition', `attachment; filename="${title}.mp3"`);
      res.setHeader('Content-Type', 'audio/mpeg');

      const stream = require('fs').createReadStream(filePath);
      stream.on('error', async (err) => {
        logger.error('Stream error:', err.message);
        await cleanup([filePath, thumbnailPath]);
        sendError('កំហុសក្នុងការទាញយក MP3!');
      });
      stream.on('end', async () => {
        logger.info('MP3 streaming completed', { filePath });
        await cleanup([filePath, thumbnailPath]);
        if (!responded) responded = true;
      });
      res.on('close', async () => {
        logger.info('Client disconnected', { filePath });
        await cleanup([filePath, thumbnailPath]);
      });
      stream.pipe(res);
    } else {
      // Video download (unchanged)
      await execYtDlp(['-f', 'best', '-o', filePath, url]);
      await fs.access(filePath);

      res.setHeader('Content-Disposition', `attachment; filename="${title}.mp4"`);
      res.setHeader('Content-Type', 'video/mp4');

      const stream = require('fs').createReadStream(filePath);
      stream.on('error', async (err) => {
        logger.error('Stream error:', err.message);
        await cleanup([filePath]);
        sendError('កំហុសក្នុងការទាញយកវីដេអូ!');
      });
      stream.on('end', async () => {
        logger.info('Video streaming completed', { filePath });
        await cleanup([filePath]);
        if (!responded) responded = true;
      });
      res.on('close', async () => {
        logger.info('Client disconnected', { filePath });
        await cleanup([filePath]);
      });
      stream.pipe(res);
    }
  } catch (error) {
    logger.error('Error downloading file:', { url, format, message: error.message });
    await cleanup([filePath, thumbnailPath]);
    sendError(`មិនអាចទាញយកបាន: ${error.message}`);
  }
});

app.listen(port, () => {
  logger.info(`Server running at http://localhost:${port}`);
});