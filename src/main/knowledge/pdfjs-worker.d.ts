/**
 * pdfjs-dist ships no typings for its worker entry. Importing it for its side effect registers
 * `globalThis.pdfjsWorker`, which lets pdf.js run its worker code on the current thread in Node.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
