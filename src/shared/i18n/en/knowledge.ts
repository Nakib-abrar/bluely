/** Modes and knowledge-file messages (main process). Failure reasons are stored as shown. */
export const knowledge = {
  reasons: {
    unsupportedType: 'Unsupported file type',
    tooLarge: 'File is larger than {mb} MB',
    pdfNoText: "This PDF has no extractable text (scanned PDFs aren't supported yet)",
    pdfPassword: 'This PDF is password-protected',
    unreadable: "Couldn't read this file: {detail}",
    empty: 'The file is empty',
    modeFull: 'This Mode already has {max} files',
    interrupted: 'Processing was interrupted. Remove the file and add it again.',
  },
  details: {
    notFound: 'file not found',
    permission: 'permission denied',
    busy: 'the file is in use by another app',
    notAFile: 'not a regular file',
    invalidPath: 'invalid path',
    invalidPdf: 'not a valid PDF',
    invalidDocx: 'not a valid Word document',
    unknown: 'unexpected error',
  },
  modes: {
    notFound: 'That Mode no longer exists.',
    builtinDelete: "Built-in Modes can't be deleted. You can reset them instead.",
    notBuiltin: 'Only built-in Modes can be reset.',
    invalid: 'Invalid Mode: {detail}',
  },
  dialog: {
    title: 'Add knowledge files',
    button: 'Add files',
    filterName: 'Documents',
  },
} as const
