# Figma Community Stats Tracker

Track users & like counts for Figma Community files.

Sends scheduled stats updates to your webhook:

```
=== Your Figma community file name ===
Users: 12345  Likes: 678
vs 2025-12-05: Users +23, Likes +5
```


## Install

```bash
curl -fsSL https://raw.githubusercontent.com/cyrus-cai/figmatrackjs/main/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/cyrus-cai/figmatrackjs.git
cd figmatrackjs
bun install && bun run build
./install.sh
```

## Uninstall

```bash
~/.figmatrack/uninstall.sh
```

## Usage

```bash
ft --add <URL>              # Add file to track
ft --remove <ID>            # Remove file
ft --list                   # List tracked files
ft --webhook                # List all webhooks
ft --webhook add <URL>      # Add a webhook
ft --webhook remove         # Remove webhook
ft --run                    # Collect stats now
ft --schedule HH:MM[,...]   # Set schedule (e.g., 09:00 or 09:00,18:00)
ft --unschedule [HH:MM,...] # Cancel schedule
ft --status                 # Check status
```

## Example

```bash
ft --add https://www.figma.com/community/file/123456789
ft --webhook add https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx
ft --schedule 09:00,21:00
```

