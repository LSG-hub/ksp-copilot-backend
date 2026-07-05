"""
build_iac.py — emit Catalyst Infrastructure-as-Code (project-template.json) for
the full KSP FIR schema, and pack it into an import-ready ZIP.

Catalyst tables can only be created via the console (manual) or IaC. This script
defines all 28 FIR tables + columns as code (matching Police_FIR_ER_Diagram.pdf
and the data-generator output), so the whole schema is reproducible and
version-controlled.

Usage:  python build_iac.py
Then:   catalyst --dc in iac:import iac_import.zip -n "KSP-Crime-DB"

Notes on types (Catalyst Data Store): int, bigint, varchar(<=255), text(<=10000),
date, datetime, double, boolean. Every table also auto-gets ROWID (bigint PK),
CREATORID, CREATEDTIME, MODIFIEDTIME. We keep our own IDs as plain columns and
join on them in ZCQL (we do NOT use Catalyst's foreignkey type, which references
ROWID rather than our business IDs).
"""
import json, os, zipfile

HERE = os.path.dirname(__file__)

# Type shorthands
I, B, V, T, D, DT, F, BOOL = "int", "bigint", "varchar", "text", "date", "datetime", "double", "boolean"

# ---- Full FIR schema: table -> [(column, type), ...] -----------------------
SCHEMA = {
    "CaseMaster": [
        ("CaseMasterID", B), ("CrimeNo", V), ("CaseNo", V), ("CrimeRegisteredDate", D),
        ("PolicePersonID", B), ("PoliceStationID", B), ("CaseCategoryID", I),
        ("GravityOffenceID", I), ("CrimeMajorHeadID", I), ("CrimeMinorHeadID", I),
        ("CaseStatusID", I), ("CourtID", B), ("IncidentFromDate", DT), ("IncidentToDate", DT),
        ("InfoReceivedPSDate", DT), ("latitude", F), ("longitude", F), ("BriefFacts", T),
    ],
    "ComplainantDetails": [
        ("ComplainantID", B), ("CaseMasterID", B), ("ComplainantName", V), ("AgeYear", I),
        ("OccupationID", I), ("ReligionID", I), ("CasteID", I), ("GenderID", I),
    ],
    "ActSectionAssociation": [
        ("CaseMasterID", B), ("ActID", V), ("SectionID", V), ("ActOrderID", I), ("SectionOrderID", I),
    ],
    "Victim": [
        ("VictimMasterID", B), ("CaseMasterID", B), ("VictimName", V), ("AgeYear", I),
        ("GenderID", I), ("VictimPolice", BOOL),
    ],
    "Accused": [
        ("AccusedMasterID", B), ("CaseMasterID", B), ("AccusedName", V), ("AgeYear", I),
        ("GenderID", I), ("PersonID", V),
    ],
    "ArrestSurrender": [
        ("ArrestSurrenderID", B), ("CaseMasterID", B), ("ArrestSurrenderTypeID", I),
        ("ArrestSurrenderDate", D), ("ArrestSurrenderStateId", I), ("ArrestSurrenderDistrictId", I),
        ("PoliceStationID", B), ("IOID", B), ("CourtID", B), ("AccusedMasterID", B),
        ("IsAccused", BOOL), ("IsComplainantAccused", BOOL),
    ],
    "Act": [("ActCode", V), ("ActDescription", V), ("ShortName", V), ("Active", BOOL)],
    "Section": [("ActCode", V), ("SectionCode", V), ("SectionDescription", V), ("Active", BOOL)],
    "CrimeHeadActSection": [("CrimeHeadID", I), ("ActCode", V), ("SectionCode", V)],
    "CrimeHead": [("CrimeHeadID", I), ("CrimeGroupName", V), ("Active", BOOL)],
    "CrimeSubHead": [("CrimeSubHeadID", I), ("CrimeHeadID", I), ("CrimeHeadName", V), ("SeqID", I)],
    "CasteMaster": [("caste_master_id", I), ("caste_master_name", V)],
    "ReligionMaster": [("ReligionID", I), ("ReligionName", V)],
    "OccupationMaster": [("OccupationID", I), ("OccupationName", V)],
    "CaseStatusMaster": [("CaseStatusID", I), ("CaseStatusName", V)],
    "Court": [("CourtID", B), ("CourtName", V), ("DistrictID", I), ("StateID", I), ("Active", BOOL)],
    "District": [("DistrictID", I), ("DistrictName", V), ("StateID", I), ("Active", BOOL)],
    "State": [("StateID", I), ("StateName", V), ("NationalityID", I), ("Active", BOOL)],
    "Unit": [
        ("UnitID", B), ("UnitName", V), ("TypeID", I), ("ParentUnit", B), ("NationalityID", I),
        ("StateID", I), ("DistrictID", I), ("Active", BOOL),
    ],
    "UnitType": [("UnitTypeID", I), ("UnitTypeName", V), ("CityDistState", V), ("Hierarchy", I), ("Active", BOOL)],
    "Rank": [("RankID", I), ("RankName", V), ("Hierarchy", I), ("Active", BOOL)],
    "Designation": [("DesignationID", I), ("DesignationName", V), ("Active", BOOL), ("SortOrder", I)],
    "Employee": [
        ("EmployeeID", B), ("DistrictID", I), ("UnitID", B), ("RankID", I), ("DesignationID", I),
        ("KGID", V), ("FirstName", V), ("EmployeeDOB", D), ("GenderID", I), ("BloodGroupID", I),
        ("PhysicallyChallenged", BOOL), ("AppointmentDate", D),
    ],
    "CaseCategory": [("CaseCategoryID", I), ("LookupValue", V)],
    "GravityOffence": [("GravityOffenceID", I), ("LookupValue", V)],
    "ChargesheetDetails": [
        ("CSID", B), ("CaseMasterID", B), ("csdate", DT), ("cstype", V), ("PolicePersonID", B),
    ],
    "Inv_OccuranceTime": [
        ("CaseMasterID", B), ("OccuranceFromDateTime", DT), ("OccuranceToDateTime", DT),
        ("DayOfWeek", V), ("TimeSlot", V), ("PlaceOfOccurance", V),
    ],
    "inv_arrestsurrenderaccused": [("ArrestSurrenderID", B), ("AccusedMasterID", B)],
}


def column_props(table, col, dtype):
    p = {
        "column_name": col,
        "data_type": dtype,
        "is_unique": False,
        "is_mandatory": False,
        "search_index_enabled": False,
        "table_id": table,
        "table_name": table,
    }
    if dtype == V:
        p["max_length"] = 255
    elif dtype == T:
        p["max_length"] = 10000
    elif dtype == F:
        p["decimal_digits"] = 6
    return p


def build():
    datastore = []
    for table, cols in SCHEMA.items():
        datastore.append({
            "type": "table",
            "name": table,
            "properties": {"table_name": table},
            "dependsOn": [],
        })
        for col, dtype in cols:
            datastore.append({
                "type": "column",
                "name": f"{table}-{col}",
                "properties": column_props(table, col, dtype),
                "dependsOn": [f"Datastore.table.{table}"],
            })

    template = {
        "name": "project-template",
        "version": "1.0.0",
        "parameters": {},
        "components": {
            "Circuits": [],
            "Functions": [],
            "WebClient": [],
            "Cron": [],
            "Datastore": datastore,
        },
    }

    out_json = os.path.join(HERE, "project-template.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(template, f, indent=2)

    out_zip = os.path.join(HERE, "iac_import.zip")
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(out_json, "project-template.json")

    n_tables = len(SCHEMA)
    n_cols = sum(len(c) for c in SCHEMA.values())
    print(f"Wrote {out_json} and {out_zip}")
    print(f"Schema: {n_tables} tables, {n_cols} business columns (+4 auto cols/table).")


if __name__ == "__main__":
    build()
