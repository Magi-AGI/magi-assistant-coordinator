/**
 * Regex-based command classifier for voice input safety.
 *
 * Classification levels:
 * - deny:    Dangerous commands — refuse entirely
 * - confirm: Destructive commands — require user confirmation
 * - safe:    Everything else — auto-send if confidence >= threshold
 */
export class CommandClassifier {
  private denyPatterns: RegExp[];
  private confirmPatterns: RegExp[];

  constructor(
    denyPatterns?: string[],
    confirmPatterns?: string[],
  ) {
    this.denyPatterns = (denyPatterns ?? DEFAULT_DENY).map(p => new RegExp(p, 'i'));
    this.confirmPatterns = (confirmPatterns ?? DEFAULT_CONFIRM).map(p => new RegExp(p, 'i'));
  }

  classify(text: string): 'safe' | 'confirm' | 'deny' {
    const trimmed = text.trim();
    if (!trimmed) return 'safe';

    for (const pattern of this.denyPatterns) {
      if (pattern.test(trimmed)) return 'deny';
    }

    for (const pattern of this.confirmPatterns) {
      if (pattern.test(trimmed)) return 'confirm';
    }

    return 'safe';
  }
}

const DEFAULT_DENY = [
  'rm\\s+(-[a-z]*)?\\s*-rf\\s+/',              // rm -rf /
  'rm\\s+(-[a-z]*\\s+)*/',                      // rm /
  'mkfs',                                       // format filesystem
  'dd\\s+if=',                                  // raw disk write
  ':\\(\\)\\s*\\{\\s*:\\|:\\s*&\\s*\\}\\s*;\\s*:', // fork bomb
  '>(\\s*/dev/sd|\\s*/dev/nvme)',               // overwrite disk device
];

const DEFAULT_CONFIRM = [
  '\\brm\\b',                                   // rm anything
  '\\bsudo\\b',                                 // sudo
  '\\bgit\\s+push\\s+--force',                  // force push
  '\\bgit\\s+push\\s+-f\\b',                    // force push short
  '\\bgit\\s+reset\\s+--hard',                  // hard reset
  '\\bgit\\s+clean\\s+-[a-z]*f',                // git clean -f
  '\\bkill\\b',                                 // kill process
  '\\bkillall\\b',                              // killall
  '\\bpkill\\b',                                // pkill
  '\\bcurl\\b.*\\|\\s*(ba)?sh',                 // curl | bash
  '\\bwget\\b.*\\|\\s*(ba)?sh',                 // wget | bash
  '\\bchmod\\b',                                // change permissions
  '\\bchown\\b',                                // change ownership
  '\\bdropdb\\b',                               // drop database
  '\\bDROP\\s+(TABLE|DATABASE)\\b',             // SQL drop
];
