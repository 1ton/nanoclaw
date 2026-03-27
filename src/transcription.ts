/**
 * Local voice transcription via whisper.cpp.
 * Converts an audio file to text using the whisper-cli binary.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'data/models/ggml-small.bin';
const WHISPER_LANG = process.env.WHISPER_LANG || 'ru';

/** Transcribe an audio file using whisper.cpp. Returns null on failure. */
export async function transcribeAudio(
  audioPath: string,
): Promise<string | null> {
  if (!fs.existsSync(WHISPER_MODEL)) {
    logger.warn(
      { model: WHISPER_MODEL },
      'Whisper model not found, skipping transcription',
    );
    return null;
  }

  // Convert to 16kHz mono WAV — whisper.cpp requires this format
  const wavPath = path.join(os.tmpdir(), `whisper-${Date.now()}.wav`);
  try {
    await execFileAsync(
      'ffmpeg',
      ['-i', audioPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath, '-y'],
      { timeout: 30_000 },
    );
  } catch (err) {
    logger.error({ err, audioPath }, 'ffmpeg conversion failed');
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', wavPath, '--no-timestamps', '-nt', '-l', WHISPER_LANG],
      { timeout: 60_000 },
    );
    const text = stdout.trim();
    logger.info(
      { audioPath, length: text.length },
      'Transcribed voice message',
    );
    return text || null;
  } catch (err) {
    logger.error({ err, audioPath }, 'whisper.cpp transcription failed');
    return null;
  } finally {
    fs.unlink(wavPath, () => {});
  }
}
