from flask import Flask, render_template, request
import sqlite3

app = Flask(__name__)

@app.route('/')
def index():
    conn = sqlite3.connect('smdr.db')
    conn.row_factory = sqlite3.Row

    date_from = request.args.get('date_from', '')
    date_to = request.args.get('date_to', '')
    search = request.args.get('search', '')
    direction = request.args.get('direction', '')

    query = 'SELECT * FROM calls WHERE 1=1'
    params = []
    if date_from:
        query += ' AND date(call_dt) >= date(?)'
        params.append(date_from)
    if date_to:
        query += ' AND date(call_dt) <= date(?)'
        params.append(date_to)
    if search:
        query += ' AND (number LIKE ? OR ext LIKE ?)'
        params.extend([f'%{search}%', f'%{search}%'])
    if direction:
        query += ' AND direction = ?'
        params.append(direction)
    query += ' ORDER BY call_dt DESC LIMIT 300'

    rows = conn.execute(query, params).fetchall()
    total = conn.execute('SELECT COUNT(*) FROM calls').fetchone()[0]
    out_count = conn.execute("SELECT COUNT(*) FROM calls WHERE direction='outgoing'").fetchone()[0]
    in_count = conn.execute("SELECT COUNT(*) FROM calls WHERE direction='incoming'").fetchone()[0]
    int_count = conn.execute("SELECT COUNT(*) FROM calls WHERE direction='internal'").fetchone()[0]

    return render_template('index.html', rows=rows,
                            date_from=date_from, date_to=date_to,
                            search=search, direction=direction,
                            total=total, out_count=out_count,
                            in_count=in_count, int_count=int_count)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)