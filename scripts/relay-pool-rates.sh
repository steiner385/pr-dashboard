#!/usr/bin/env bash
# Relay TRUE per-capacity-type EC2 cost from AWS Cost Explorer into the
# dashboard's pool-rate config (config.json `poolMeta[*].dollarsPerMinute`).
#
#   relay-pool-rates.sh [DAYS_BACK]    (default 30)
#
# How it works:
#   1. CE: EC2-Compute UnblendedCost over the window, grouped by PURCHASE_TYPE
#      → spot $ and on-demand $ (Reserved/Savings count as on-demand).
#   2. Dashboard: per-pool runner-minutes over the same window (/api/metrics).
#   3. Rate per capacity type = type $ ÷ that type's runner-minutes. Each pool is
#      classified spot/on-demand by its name / poolMeta instanceType; GitHub-
#      hosted pools (ubuntu-latest) are on a separate GitHub bill and are skipped.
#      A "spot" pool with no real spot spend (the label is aspirational until a
#      spot NodePool is deployed) falls back to the on-demand rate — those jobs
#      actually ran on on-demand nodes, so on-demand is the honest price.
#   4. Writes the rates into config.json and reloads the dashboard.
#
# Self-correcting: re-run daily (systemd timer). The day a real spot NodePool
# lands, CE will show spot spend and the spot pools split to the cheaper rate
# automatically — no code change.
#
# Reconciliation: the on-demand rate's denominator is the SAME minute snapshot
# the dashboard prices against, so attributed-$ == actual-$ for that capacity
# type by construction. Cumulative fleet coverage settles at EC2-Compute ÷
# total-fleet (~90%; the gap is non-compute EC2-Other/EKS/VPC). Two expected,
# benign wrinkles: (a) coverage spikes for ~30s right after the reload below
# while pool-learning re-warms the volatile `unknown` pool, then settles;
# (b) per-DAY coverage is noisy (a blended monthly $/min won't match each day's
# CE allocation) — the cumulative number is the meaningful one.
#
# Env:
#   PRDASH_URL      dashboard base URL   (default http://127.0.0.1:4400)
#   PRDASH_CONFIG   config.json path     (default <repo>/config.json)
#   DRY_RUN=1       print the computed rates, do NOT write config or reload
#
# Requires: aws CLI with ce:GetCostAndUsage, python3, curl. CE charges ~$0.01/run.
set -euo pipefail
DAYS="${1:-30}"
URL="${PRDASH_URL:-http://127.0.0.1:4400}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${PRDASH_CONFIG:-$SCRIPT_DIR/../config.json}"
START=$(date -u -d "$DAYS days ago" +%F)
END=$(date -u -d "tomorrow" +%F)

CE=$(aws ce get-cost-and-usage \
  --time-period "Start=$START,End=$END" \
  --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=PURCHASE_TYPE \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Elastic Compute Cloud - Compute"]}}' \
  --output json)

METRICS=$(curl -sf "$URL/api/metrics?windowDays=$DAYS")

CE="$CE" METRICS="$METRICS" CONFIG="$CONFIG" DAYS="$DAYS" DRY_RUN="${DRY_RUN:-0}" python3 - <<'PY'
import json, os, sys

ce = json.loads(os.environ["CE"])
metrics = json.loads(os.environ["METRICS"])
cfg_path = os.environ["CONFIG"]
dry = os.environ.get("DRY_RUN", "0") == "1"

# 1. EC2-Compute $ split spot vs on-demand (Reserved/Savings → on-demand).
spot_dollars = ondemand_dollars = 0.0
for period in ce.get("ResultsByTime", []):
    for g in period.get("Groups", []):
        key = (g.get("Keys") or [""])[0]
        amt = float(g["Metrics"]["UnblendedCost"]["Amount"])
        if "spot" in key.lower():
            spot_dollars += amt
        else:
            ondemand_dollars += amt

# 2. Per-pool runner-minutes over the window (summed across repos).
minutes = {}
for repo in metrics.get("cost", []) or []:
    for p in repo.get("pools", []) or []:
        minutes[p["pool"]] = minutes.get(p["pool"], 0.0) + (p.get("minutes") or 0.0)

cfg = json.load(open(cfg_path))
pool_meta = cfg.setdefault("poolMeta", {})

def classify(pool):
    """spot | ondemand | hosted — by pool name, then poolMeta instanceType."""
    name = pool.lower()
    itype = (pool_meta.get(pool, {}).get("instanceType") or "").lower()
    if "ubuntu" in name or "hosted" in itype or "github" in itype:
        return "hosted"          # billed by GitHub, not on the EC2 fleet
    if "|" in pool:
        return "ondemand"        # runs-on ternary — price at the conservative branch
    if "spot" in name or "spot" in itype:
        return "spot"
    return "ondemand"            # kindash-arc, -xl, unknown, ci-fast → on-demand

spot_min = sum(m for p, m in minutes.items() if classify(p) == "spot")
od_min   = sum(m for p, m in minutes.items() if classify(p) == "ondemand")

od_rate   = (ondemand_dollars / od_min) if od_min > 0 else None
# Honest fallback: a 'spot' pool with negligible real spot spend ran on on-demand.
spot_rate = (spot_dollars / spot_min) if (spot_dollars > 1.0 and spot_min > 0) else od_rate

print(f"AWS EC2-Compute over {os.environ['DAYS']}d: spot ${spot_dollars:.2f}, on-demand ${ondemand_dollars:.2f}")
print(f"runner-minutes: spot {spot_min:.0f}, on-demand {od_min:.0f}")
print(f"derived $/min: on-demand {od_rate}, spot {spot_rate}"
      + ("  (spot=on-demand fallback — no real spot spend yet)" if spot_dollars <= 1.0 else ""))

if od_rate is None:
    print("no on-demand runner-minutes in the window — nothing to write", file=sys.stderr)
    sys.exit(0)

# 3. Write a rate into poolMeta for every observed non-hosted pool.
changed = []
for pool in sorted(minutes):
    klass = classify(pool)
    if klass == "hosted":
        continue
    rate = round(spot_rate if klass == "spot" else od_rate, 6)
    entry = pool_meta.setdefault(pool, {})
    if entry.get("dollarsPerMinute") != rate:
        changed.append((pool, entry.get("dollarsPerMinute"), rate, klass))
    entry["dollarsPerMinute"] = rate
    entry.setdefault("podsPerNode", 1)
    entry.setdefault("instanceType", "EKS ARC (spot)" if klass == "spot" else "EKS ARC (on-demand)")
    entry["note"] = f"auto-relayed from AWS CE ({klass}) — relay-pool-rates.sh"

for pool, old, new, klass in changed:
    print(f"  {pool} [{klass}]: {old} -> {new}/min")
if not changed:
    print("  (rates already current)")

if dry:
    print("DRY_RUN — config not written")
    sys.exit(0)

json.dump(cfg, open(cfg_path, "w"), indent=2)
print(f"wrote {len(changed)} rate change(s) to {cfg_path}")
PY

if [ "${DRY_RUN:-0}" != "1" ]; then
  curl -sf -X POST "$URL/api/admin/restart" >/dev/null 2>&1 \
    && echo "reloading dashboard to apply rates" \
    || echo "rates written; restart the dashboard to apply (POST $URL/api/admin/restart failed/skipped)"
fi
