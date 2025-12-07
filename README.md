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
# Files
ft --add <URL>                # Add file to track
ft --remove                   # Remove file (interactive)
ft --list                     # List tracked files

# Schedule
ft --run                      # Collect stats now
ft --schedule add <HH:MM>     # Add schedule (e.g. 09:00 18:00 or 09:00,18:00)
ft --schedule remove          # Remove schedule (interactive)
ft --schedule                 # List schedule

# Webhook
ft --webhook add <URL>        # Add a webhook
ft --webhook remove           # Remove webhook (interactive)
ft --webhook                  # List webhooks
```

## Example

```bash
ft --add https://www.figma.com/community/file/123456789
ft --schedule add 09:00 21:00
ft --webhook add https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx
```

