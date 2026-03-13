#!/usr/bin/env python3
"""SQLite-backed MVP server for the disaster coordination dashboard."""

from __future__ import annotations

import json
import re
import sqlite3
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

PORT = 8000
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "acil_afet.db"

SEED_TEAMS = [
    {"name": "Alfa Ekibi", "members": 8, "status": "active", "lat": 39.9334, "lng": 32.8597, "mission": "Arama Kurtarma"},
    {"name": "Bravo Ekibi", "members": 6, "status": "active", "lat": 41.0082, "lng": 28.9784, "mission": "Tibbi Destek"},
    {"name": "Charlie Ekibi", "members": 10, "status": "standby", "lat": 38.4192, "lng": 27.1287, "mission": "Lojistik"},
    {"name": "Delta Ekibi", "members": 7, "status": "active", "lat": 37.0660, "lng": 37.3781, "mission": "Iletisim"},
    {"name": "Echo Ekibi", "members": 9, "status": "active", "lat": 36.8969, "lng": 30.7133, "mission": "Guvenlik"},
]

SEED_DISASTERS = [
    {
        "type": "Deprem",
        "severity": "high",
        "status": "in_progress",
        "lat": 38.3552,
        "lng": 38.3095,
        "city": "Elazig",
        "district": "Merkez",
        "description": "5.8 buyuklugunde deprem sonrasi saha koordinasyonu suruyor.",
        "contact": "Mehmet Yilmaz",
        "phone": "0532 123 4567",
        "assigned_teams": [1, 2],
    },
    {
        "type": "Sel",
        "severity": "medium",
        "status": "new",
        "lat": 41.0053,
        "lng": 39.7178,
        "city": "Rize",
        "district": "Merkez",
        "description": "Yagis sonrasi su baskini bildirildi, riskli noktalar taraniyor.",
        "contact": "Ayse Kara",
        "phone": "0543 222 3344",
        "assigned_teams": [4],
    },
]


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)

    with get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS teams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                members INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active', 'standby')),
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                mission TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS disasters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high')),
                status TEXT NOT NULL CHECK(status IN ('new', 'in_progress', 'resolved', 'archived')),
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                city TEXT NOT NULL,
                district TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL,
                contact TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                resolved_at TEXT
            );

            CREATE TABLE IF NOT EXISTS disaster_assignments (
                disaster_id INTEGER NOT NULL,
                team_id INTEGER NOT NULL,
                assigned_at TEXT NOT NULL,
                PRIMARY KEY (disaster_id, team_id),
                FOREIGN KEY (disaster_id) REFERENCES disasters(id) ON DELETE CASCADE,
                FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                disaster_id INTEGER NOT NULL,
                author TEXT NOT NULL,
                text TEXT NOT NULL,
                is_system INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (disaster_id) REFERENCES disasters(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                disaster_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (disaster_id) REFERENCES disasters(id) ON DELETE CASCADE
            );
            """
        )

        if connection.execute("SELECT COUNT(*) FROM teams").fetchone()[0] == 0:
            seed_teams(connection)

        if connection.execute("SELECT COUNT(*) FROM disasters").fetchone()[0] == 0:
            seed_disasters(connection)


def seed_teams(connection: sqlite3.Connection) -> None:
    timestamp = now_iso()
    for team in SEED_TEAMS:
        connection.execute(
            """
            INSERT INTO teams (name, members, status, lat, lng, mission, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (team["name"], team["members"], team["status"], team["lat"], team["lng"], team["mission"], timestamp, timestamp),
        )


def seed_disasters(connection: sqlite3.Connection) -> None:
    for disaster in SEED_DISASTERS:
        disaster_id = create_disaster_record(connection, disaster)

        for team_id in disaster.get("assigned_teams", []):
            assign_team(connection, disaster_id, team_id, notify=False)

        create_message(
            connection,
            disaster_id,
            "Sistem",
            f"{disaster['city']} - {disaster['type']} icin iletisim kanali olusturuldu.",
            is_system=True,
        )


def create_disaster_record(connection: sqlite3.Connection, payload: dict[str, object]) -> int:
    cursor = connection.execute(
        """
        INSERT INTO disasters (
            type, severity, status, lat, lng, city, district, description, contact, phone, created_at, resolved_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload["type"],
            payload["severity"],
            payload.get("status", "new"),
            payload["lat"],
            payload["lng"],
            payload["city"],
            payload.get("district", ""),
            payload["description"],
            payload.get("contact", ""),
            payload.get("phone", ""),
            now_iso(),
            payload.get("resolved_at"),
        ),
    )
    disaster_id = int(cursor.lastrowid)
    record_activity(connection, disaster_id, "created", "Olay kaydi olusturuldu.")
    return disaster_id


def create_message(connection: sqlite3.Connection, disaster_id: int, author: str, text: str, *, is_system: bool = False) -> None:
    connection.execute(
        """
        INSERT INTO messages (disaster_id, author, text, is_system, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (disaster_id, author, text, int(is_system), now_iso()),
    )


def record_activity(connection: sqlite3.Connection, disaster_id: int, kind: str, message: str) -> None:
    connection.execute(
        """
        INSERT INTO activity_logs (disaster_id, kind, message, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (disaster_id, kind, message, now_iso()),
    )


def disaster_exists(connection: sqlite3.Connection, disaster_id: int) -> bool:
    return connection.execute("SELECT 1 FROM disasters WHERE id = ?", (disaster_id,)).fetchone() is not None


def team_exists(connection: sqlite3.Connection, team_id: int) -> bool:
    return connection.execute("SELECT 1 FROM teams WHERE id = ?", (team_id,)).fetchone() is not None


def create_team_record(connection: sqlite3.Connection, payload: dict[str, object]) -> int:
    timestamp = now_iso()
    cursor = connection.execute(
        """
        INSERT INTO teams (name, members, status, lat, lng, mission, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload["name"],
            payload["members"],
            payload["status"],
            payload["lat"],
            payload["lng"],
            payload["mission"],
            timestamp,
            timestamp,
        ),
    )
    return int(cursor.lastrowid)


def assign_team(connection: sqlite3.Connection, disaster_id: int, team_id: int, *, notify: bool = True) -> None:
    connection.execute(
        """
        INSERT OR IGNORE INTO disaster_assignments (disaster_id, team_id, assigned_at)
        VALUES (?, ?, ?)
        """,
        (disaster_id, team_id, now_iso()),
    )
    connection.execute(
        """
        UPDATE disasters
        SET status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END
        WHERE id = ?
        """,
        (disaster_id,),
    )

    team = connection.execute("SELECT name FROM teams WHERE id = ?", (team_id,)).fetchone()
    if team and notify:
        create_message(connection, disaster_id, "Sistem", f"{team['name']} olaya atandi.", is_system=True)
        record_activity(connection, disaster_id, "assignment", f"{team['name']} gorevlendirildi.")


def remove_assignment(connection: sqlite3.Connection, disaster_id: int, team_id: int) -> None:
    team = connection.execute("SELECT name FROM teams WHERE id = ?", (team_id,)).fetchone()
    connection.execute("DELETE FROM disaster_assignments WHERE disaster_id = ? AND team_id = ?", (disaster_id, team_id))
    if team:
        create_message(connection, disaster_id, "Sistem", f"{team['name']} olaydan kaldirildi.", is_system=True)
        record_activity(connection, disaster_id, "assignment_removed", f"{team['name']} gorevden alindi.")


def resolve_disaster(connection: sqlite3.Connection, disaster_id: int) -> None:
    connection.execute(
        """
        UPDATE disasters
        SET status = 'resolved', resolved_at = ?
        WHERE id = ?
        """,
        (now_iso(), disaster_id),
    )
    create_message(connection, disaster_id, "Sistem", "Olay cozuldu olarak isaretlendi.", is_system=True)
    record_activity(connection, disaster_id, "resolved", "Olay cozuldu durumuna alindi.")


def build_state(connection: sqlite3.Connection) -> dict[str, object]:
    team_rows = connection.execute(
        """
        SELECT id, name, members, status, lat, lng, mission, updated_at
        FROM teams
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name
        """
    ).fetchall()
    disaster_rows = connection.execute(
        """
        SELECT id, type, severity, status, lat, lng, city, district, description, contact, phone, created_at, resolved_at
        FROM disasters
        ORDER BY CASE status WHEN 'resolved' THEN 1 ELSE 0 END, created_at DESC
        """
    ).fetchall()
    assignment_rows = connection.execute("SELECT disaster_id, team_id FROM disaster_assignments ORDER BY assigned_at").fetchall()
    message_rows = connection.execute(
        """
        SELECT id, disaster_id, author, text, is_system, created_at
        FROM messages
        ORDER BY created_at ASC, id ASC
        """
    ).fetchall()
    activity_rows = connection.execute(
        """
        SELECT id, disaster_id, kind, message, created_at
        FROM activity_logs
        ORDER BY created_at DESC, id DESC
        """
    ).fetchall()

    assignments_by_disaster: dict[int, list[int]] = {}
    for row in assignment_rows:
        assignments_by_disaster.setdefault(row["disaster_id"], []).append(row["team_id"])

    messages_by_disaster: dict[int, list[dict[str, object]]] = {}
    for row in message_rows:
        messages_by_disaster.setdefault(row["disaster_id"], []).append(
            {"id": row["id"], "author": row["author"], "text": row["text"], "isSystem": bool(row["is_system"]), "time": row["created_at"]}
        )

    activity_by_disaster: dict[int, list[dict[str, object]]] = {}
    for row in activity_rows:
        activity_by_disaster.setdefault(row["disaster_id"], []).append(
            {"id": row["id"], "kind": row["kind"], "message": row["message"], "time": row["created_at"]}
        )

    teams = [
        {
            "id": row["id"],
            "name": row["name"],
            "members": row["members"],
            "status": row["status"],
            "location": [row["lat"], row["lng"]],
            "mission": row["mission"],
            "updatedAt": row["updated_at"],
        }
        for row in team_rows
    ]

    disasters = []
    for row in disaster_rows:
        disaster_id = row["id"]
        disasters.append(
            {
                "id": disaster_id,
                "type": row["type"],
                "severity": row["severity"],
                "status": row["status"],
                "location": [row["lat"], row["lng"]],
                "city": row["city"],
                "district": row["district"],
                "description": row["description"],
                "contact": row["contact"],
                "phone": row["phone"],
                "time": row["created_at"],
                "resolvedTime": row["resolved_at"],
                "assignedTeams": assignments_by_disaster.get(disaster_id, []),
                "messages": messages_by_disaster.get(disaster_id, []),
                "activity": activity_by_disaster.get(disaster_id, []),
            }
        )

    avg_response_minutes = None
    resolved_rows = [row for row in disaster_rows if row["resolved_at"]]
    if resolved_rows:
        total_minutes = 0.0
        for row in resolved_rows:
            total_minutes += (
                datetime.fromisoformat(row["resolved_at"]) - datetime.fromisoformat(row["created_at"])
            ).total_seconds() / 60
        avg_response_minutes = round(total_minutes / len(resolved_rows))

    return {
        "teams": teams,
        "disasters": disasters,
        "stats": {
            "teamCount": sum(1 for team in teams if team["status"] == "active"),
            "disasterCount": sum(1 for disaster in disasters if disaster["status"] != "resolved"),
            "responseMinutes": avg_response_minutes,
            "resolvedCount": sum(1 for disaster in disasters if disaster["status"] == "resolved"),
        },
        "serverTime": now_iso(),
    }


def read_json_body(handler: "ApiRequestHandler") -> dict[str, object]:
    content_length = int(handler.headers.get("Content-Length", "0"))
    raw_body = handler.rfile.read(content_length) if content_length else b"{}"

    decoded_body = None
    for encoding in ("utf-8", "cp1254", "latin-1"):
        try:
            decoded_body = raw_body.decode(encoding)
            break
        except UnicodeDecodeError:
            continue

    if decoded_body is None:
        raise ValueError("Istek govdesi okunamadi.")

    try:
        return json.loads(decoded_body or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError("Gecersiz JSON gonderildi.") from exc


class ApiRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:
        print(f"[AcilAfet] {self.client_address[0]} - {format % args}")

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json({"ok": True, "serverTime": now_iso()})
            return

        if parsed.path == "/api/state":
            with get_connection() as connection:
                self.send_json(build_state(connection))
            return

        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        try:
            payload = read_json_body(self)
            with get_connection() as connection:
                if parsed.path == "/api/teams":
                    team_id = self.handle_create_team(connection, payload)
                    self.send_json({"ok": True, "teamId": team_id}, status=HTTPStatus.CREATED)
                    return

                if parsed.path == "/api/disasters":
                    disaster_id = self.handle_create_disaster(connection, payload)
                    self.send_json({"ok": True, "disasterId": disaster_id}, status=HTTPStatus.CREATED)
                    return

                assignment_match = re.fullmatch(r"/api/disasters/(\d+)/assignments", parsed.path)
                if assignment_match:
                    self.handle_assign_team(connection, int(assignment_match.group(1)), payload)
                    self.send_json({"ok": True})
                    return

                message_match = re.fullmatch(r"/api/disasters/(\d+)/messages", parsed.path)
                if message_match:
                    self.handle_create_message(connection, int(message_match.group(1)), payload)
                    self.send_json({"ok": True}, status=HTTPStatus.CREATED)
                    return

                resolve_match = re.fullmatch(r"/api/disasters/(\d+)/resolve", parsed.path)
                if resolve_match:
                    self.handle_resolve_disaster(connection, int(resolve_match.group(1)))
                    self.send_json({"ok": True})
                    return
        except ValueError as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        except LookupError as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=HTTPStatus.NOT_FOUND)
            return

        self.send_json({"ok": False, "error": "Endpoint bulunamadi."}, status=HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        match = re.fullmatch(r"/api/disasters/(\d+)/assignments/(\d+)", parsed.path)
        if not match:
            self.send_json({"ok": False, "error": "Endpoint bulunamadi."}, status=HTTPStatus.NOT_FOUND)
            return

        disaster_id = int(match.group(1))
        team_id = int(match.group(2))

        with get_connection() as connection:
            if not disaster_exists(connection, disaster_id):
                self.send_json({"ok": False, "error": "Olay bulunamadi."}, status=HTTPStatus.NOT_FOUND)
                return

            remove_assignment(connection, disaster_id, team_id)
            self.send_json({"ok": True})

    def handle_create_disaster(self, connection: sqlite3.Connection, payload: dict[str, object]) -> int:
        required_fields = ["type", "severity", "city", "description", "lat", "lng"]
        for field in required_fields:
            if payload.get(field) in (None, ""):
                raise ValueError("Zorunlu alanlar eksik.")

        disaster_id = create_disaster_record(
            connection,
            {
                "type": str(payload["type"]),
                "severity": str(payload["severity"]),
                "status": "new",
                "lat": float(payload["lat"]),
                "lng": float(payload["lng"]),
                "city": str(payload["city"]),
                "district": str(payload.get("district", "")),
                "description": str(payload["description"]),
                "contact": str(payload.get("contact", "")),
                "phone": str(payload.get("phone", "")),
            },
        )
        create_message(connection, disaster_id, "Sistem", f"{payload['city']} - {payload['type']} icin iletisim kanali olusturuldu.", is_system=True)
        return disaster_id

    def handle_create_team(self, connection: sqlite3.Connection, payload: dict[str, object]) -> int:
        required_fields = ["name", "members", "status", "mission", "lat", "lng"]
        for field in required_fields:
            if payload.get(field) in (None, ""):
                raise ValueError("Ekip bilgileri eksik.")

        name = str(payload["name"]).strip()
        mission = str(payload["mission"]).strip()
        status = str(payload["status"])
        members = int(payload["members"])
        lat = float(payload["lat"])
        lng = float(payload["lng"])

        if not name or not mission:
            raise ValueError("Ekip adi ve gorev alani zorunludur.")
        if status not in {"active", "standby"}:
            raise ValueError("Gecersiz ekip durumu.")
        if members <= 0:
            raise ValueError("Ekip uye sayisi sifirdan buyuk olmali.")
        if not (35 <= lat <= 43 and 25 <= lng <= 45):
            raise ValueError("Koordinatlar Turkiye sinirlari icinde olmali.")

        return create_team_record(
            connection,
            {
                "name": name,
                "members": members,
                "status": status,
                "mission": mission,
                "lat": lat,
                "lng": lng,
            },
        )

    def handle_assign_team(self, connection: sqlite3.Connection, disaster_id: int, payload: dict[str, object]) -> None:
        if not disaster_exists(connection, disaster_id):
            raise LookupError("Olay bulunamadi.")
        if payload.get("teamId") in (None, ""):
            raise ValueError("Ekip secilmedi.")

        team_id = int(payload["teamId"])
        if not team_exists(connection, team_id):
            raise LookupError("Ekip bulunamadi.")

        existing = connection.execute(
            "SELECT 1 FROM disaster_assignments WHERE disaster_id = ? AND team_id = ?",
            (disaster_id, team_id),
        ).fetchone()
        if existing:
            raise ValueError("Bu ekip zaten atanmis.")

        assign_team(connection, disaster_id, team_id)

    def handle_create_message(self, connection: sqlite3.Connection, disaster_id: int, payload: dict[str, object]) -> None:
        if not disaster_exists(connection, disaster_id):
            raise LookupError("Olay bulunamadi.")

        text = str(payload.get("text", "")).strip()
        author = str(payload.get("author", "Koordinator")).strip() or "Koordinator"
        if not text:
            raise ValueError("Mesaj bos olamaz.")

        create_message(connection, disaster_id, author, text)
        record_activity(connection, disaster_id, "message", f"{author} mesaj gonderdi.")

    def handle_resolve_disaster(self, connection: sqlite3.Connection, disaster_id: int) -> None:
        if not disaster_exists(connection, disaster_id):
            raise LookupError("Olay bulunamadi.")
        resolve_disaster(connection, disaster_id)

    def send_json(self, payload: dict[str, object], *, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    init_db()

    print("=" * 60)
    print("CrisisDesk MVP")
    print("=" * 60)
    print(f"Dizin: {BASE_DIR}")
    print(f"Veritabani: {DB_PATH}")
    print(f"URL: http://localhost:{PORT}")
    print("=" * 60)
    print("Sunucuyu durdurmak icin CTRL+C kullanin")
    print("=" * 60)

    server = ThreadingHTTPServer(("", PORT), ApiRequestHandler)

    try:
        webbrowser.open(f"http://localhost:{PORT}")
    except OSError:
        print("Tarayici otomatik acilamadi. URL'yi manuel acin.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nSunucu durduruluyor...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
