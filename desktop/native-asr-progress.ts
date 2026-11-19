/** Parse only whisper.cpp's actual inference progress, including split stderr chunks. */
export function createWhisperProgressParser(onProgress: (percent: number) => void) {
  let buffer = '';
  let previous = -1;
  return (chunk: string) => {
    buffer = (buffer + chunk).slice(-4096);
    const expression = /whisper_print_progress_callback:\s*progress\s*=\s*(\d{1,3})\s*%/gi;
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = expression.exec(buffer))) {
      consumed = expression.lastIndex;
      const value = Number(match[1]);
      if (value >= 0 && value <= 100 && value > previous) {
        previous = value;
        onProgress(value);
      }
    }
    if (consumed) buffer = buffer.slice(consumed);
  };
}
