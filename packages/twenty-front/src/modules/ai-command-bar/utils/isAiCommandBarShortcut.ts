type ShortcutEvent = {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
};

// Ctrl/Cmd+K opens the command menu and Ctrl/Cmd+J opens the log console.
export const isAiCommandBarShortcut = (event: ShortcutEvent): boolean =>
  event.code === 'KeyK' &&
  event.shiftKey &&
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.repeat;
