"""
load_data.py — bulk-load the generated FIR CSVs into the KSP-Crime-DB Data Store
via the guarded /admin/load endpoint on the api function (no Stratus / no CLI jobs).

Type coercion is driven by the same schema used to create the tables (build_iac.SCHEMA),
so ints/doubles/booleans/dates are sent as proper JSON types. Empty cells -> omitted (null).

Usage:  python load_data.py            # load all tables
        python load_data.py State City # load only named tables
"""
import csv, json, os, sys, time, urllib.request, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "data-generator", "output"))
BASE_URL = os.environ.get("KSP_API_URL",
    "https://ksp-crime-db-60074558778.development.catalystserverless.in/server/api")
# Never hard-code the seed token (repo is public). Set the same value here and in
# the function's SEED_TOKEN env var (via catalyst-config.json locally) before loading:
#   KSP_SEED_TOKEN=... python load_data.py
SEED_TOKEN = os.environ.get("KSP_SEED_TOKEN", "")
BATCH = 100

# Load SCHEMA (column -> type) from build_iac.py
spec = importlib.util.spec_from_file_location("build_iac", os.path.join(HERE, "build_iac.py"))
biac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(biac)
COLTYPES = {t: dict(cols) for t, cols in biac.SCHEMA.items()}
INT_T, BIGINT_T, DOUBLE_T, BOOL_T = biac.I, biac.B, biac.F, biac.BOOL


def coerce(table, col, raw):
    if raw is None or raw == "":
        return None
    dt = COLTYPES.get(table, {}).get(col)
    try:
        if dt in (INT_T, BIGINT_T):
            return int(float(raw))
        if dt == DOUBLE_T:
            return float(raw)
        if dt == BOOL_T:
            return str(raw).strip().lower() in ("1", "true", "yes")
    except (ValueError, TypeError):
        return raw
    return raw  # varchar/text/date/datetime -> string as-is


def post(path, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE_URL + path, data=data, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "x-seed-token": SEED_TOKEN})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def load_table(table):
    path = os.path.join(CSV_DIR, f"{table}.csv")
    if not os.path.exists(path):
        print(f"  ! {table}: CSV not found, skipping")
        return 0
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    clean = []
    for row in rows:
        obj = {}
        for col, val in row.items():
            cv = coerce(table, col, val)
            if cv is not None:
                obj[col] = cv
        clean.append(obj)

    total_ins = 0
    for i in range(0, len(clean), BATCH):
        batch = clean[i:i + BATCH]
        for attempt in range(3):
            try:
                res = post("/admin/load", {"table": table, "rows": batch})
                if "error" in res:
                    raise RuntimeError(res["error"])
                total_ins += res.get("inserted", 0)
                break
            except Exception as e:  # noqa
                if attempt == 2:
                    print(f"  ! {table} batch {i//BATCH}: FAILED {e}")
                else:
                    time.sleep(1.5)
    print(f"  ✓ {table}: {total_ins}/{len(clean)} rows")
    return total_ins


def main():
    tables = sys.argv[1:] or list(biac.SCHEMA.keys())
    print(f"Loading {len(tables)} tables from {CSV_DIR}\n")
    grand = 0
    for t in tables:
        grand += load_table(t)
    print(f"\nDone. Inserted ~{grand} rows total.")


if __name__ == "__main__":
    main()
