import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
const { Pool } = pkg;
import bcrypt from "bcryptjs";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// ======================
// 🔥 CONEXIÓN A POSTGRES
// ======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Helper para consultas
async function query(sql, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// ==============================
// 🔥 RUTA DE REGISTRO DE USUARIO
// ==============================
app.post("/auth/register", async (req, res) => {
  try {
    const { nombre, email, password, rol_id } = req.body;

    const hashed = bcrypt.hashSync(password, 10);

    const resp = await query(
      `INSERT INTO usuarios(nombre, email, password, rol_id, fecha_registro)
       VALUES($1, $2, $3, $4, NOW())
       RETURNING id, nombre, email, rol_id`,
      [nombre, email, hashed, rol_id]
    );

    res.json(resp[0]);
  } catch (err) {
    console.error("❌ Error en /auth/register:", err);
    res.status(500).json({ error: "No se pudo registrar usuario" });
  }
});

// ===========================
// 🔥 RUTA LOGIN
// ===========================
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const rows = await query(`SELECT * FROM usuarios WHERE email=$1`, [email]);

    if (rows.length === 0) return res.status(401).json({ error: "User not found" });

    const user = rows[0];

    if (!bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: "Invalid password" });

    res.json({
      id: user.id,
      nombre: user.nombre,
      email: user.email,
      rol_id: user.rol_id,
      credits: user.credits ?? 3, // default si no existe columna
    });
  } catch (err) {
    console.error("❌ Error en /auth/login:", err);
    res.status(500).json({ error: "Login error" });
  }
});

// ========================================
// 🔥 OBTENER TODAS LAS SOLICITUDES (artista)
// ========================================
app.get("/solicitudes", async (req, res) => {
  try {
    const rows = await query(
      `SELECT s.*,
        COALESCE((SELECT COUNT(*) FROM desbloqueos d WHERE d.solicitud_id = s.id), 0) AS desbloqueos
       FROM solicitudes s
       ORDER BY s.fecha_creacion DESC`
    );

    res.json(rows);
  } catch (err) {
    console.error("❌ Error obteniendo solicitudes:", err);
    res.status(500).json({ error: "No se pudieron obtener solicitudes" });
  }
});

// ================================================
// 🔥 OBTENER SOLICITUDES DE UN CLIENTE (dashboard)
// ================================================
app.get("/solicitudes/cliente/:id", async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM solicitudes
       WHERE cliente_id = $1
       ORDER BY fecha_creacion DESC`,
      [req.params.id]
    );

    res.json(rows);
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: "No se pudieron obtener solicitudes del cliente" });
  }
});

// ==================================================
// 🔥 CREAR NUEVA SOLICITUD
// ==================================================
app.post("/solicitudes", async (req, res) => {
  try {
    const { cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas } =
      req.body;

    const rows = await query(
      `INSERT INTO solicitudes(cliente_id, titulo, descripcion, tipo_musica, fecha_evento, cantidad_ofertas, estado, fecha_creacion)
       VALUES($1,$2,$3,$4,NULL,$5,'abierta',NOW())
       RETURNING *`,
      [cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error creando solicitud:", err);
    res.status(500).json({ error: "No se pudo crear la solicitud" });
  }
});

// =============================================================
// 🔥 DESBLOQUEAR SOLICITUD (artista paga 1 crédito y obtiene acceso)
// =============================================================
app.post("/solicitudes/desbloquear", async (req, res) => {
  try {
    const { artista_id, solicitud_id } = req.body;

    // Traer solicitud
    const sol = await query(`SELECT * FROM solicitudes WHERE id=$1`, [
      solicitud_id,
    ]);

    if (sol.length === 0)
      return res.status(404).json({ error: "Solicitud no encontrada" });

    const solicitud = sol[0];

    // Conteo de desbloqueos actuales
    const desbloqs = await query(
      `SELECT COUNT(*) AS c FROM desbloqueos WHERE solicitud_id=$1`,
      [solicitud_id]
    );
    const usados = parseInt(desbloqs[0].c);

    if (usados >= solicitud.cantidad_ofertas)
      return res.status(403).json({ error: "Se alcanzó el límite de ofertas" });

    // Verificar si el artista ya desbloqueó
    const existe = await query(
      `SELECT * FROM desbloqueos WHERE solicitud_id=$1 AND artista_id=$2`,
      [solicitud_id, artista_id]
    );

    if (existe.length > 0)
      return res.status(400).json({ error: "Ya desbloqueado previamente" });

    // Descontar crédito
    await query(
      `UPDATE usuarios SET credits = credits - 1 WHERE id=$1`,
      [artista_id]
    );

    // Registrar desbloqueo
    await query(
      `INSERT INTO desbloqueos(solicitud_id, artista_id) VALUES($1,$2)`,
      [solicitud_id, artista_id]
    );

    // Obtener créditos actualizados
    const user = await query(`SELECT credits FROM usuarios WHERE id=$1`, [
      artista_id,
    ]);

    res.json({ ok: true, nuevosCreditos: user[0].credits });
  } catch (err) {
    console.error("❌ Error desbloqueando solicitud:", err);
    res.status(500).json({ error: "No se pudo desbloquear solicitud" });
  }
});

// SERVIDOR
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 MuseLink backend funcionando en http://localhost:${PORT}`)
);
