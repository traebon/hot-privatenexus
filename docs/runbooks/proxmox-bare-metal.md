# Recovery Runbook — Proxmox (bare metal)

External dependency, not run or backed up by PrivateNexus. The bare-metal
hypervisor (AMD EPYC 3151) hosting the 7 production VMs. Backs
PrivateNexus's Proxmox discovery scanner and infrastructure dashboards.

**Currently down** — ongoing NIC/PCIe hardware fault (Hostkey ticket
CS-471548), not a PrivateNexus bug. As of 2026-07-16 the decision was made
to take a pro-rata refund rather than accept a downgraded replacement — see
memory `hostkey_server_replacement` for the live status, since this thread
moves independently of PrivateNexus.

## Why PrivateNexus doesn't back this up

Proxmox has its own backup pipeline entirely outside PrivateNexus (vzdump
snapshots, config-sync to git, rclone-crypt to Hetzner/B2) — see the main
infrastructure CLAUDE.md's **"Backup Architecture"** table and
**"Hardware — Bare Metal"** section for the real recovery procedure once
the hardware itself is replaced.

**See:** `https://github.com/traebon/hot-config/blob/main/CLAUDE.md`,
sections **"Hardware — Bare Metal (AMD EPYC 3151)"** and
**"Operational Rules"** (`Proxmox NIC PCIe link loss` row).

## Impact of this being down

PrivateNexus's Proxmox discovery source and any Proxmox-derived dashboard
data are unavailable — already an accepted, documented state, not something
this runbook needs to resolve. All 7 production VMs behind it are similarly
unreachable, which is the real incident this traces back to, tracked
separately from PrivateNexus.

## Verify

`tcp://10.10.0.2:8006` — will correctly report down until the hardware
issue is resolved.
