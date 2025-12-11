// ===============================
// MuseLink Backend - ES MODULE VERSION
// ===============================

import "dotenv/config";
import express from "express";
import cors from "cors";
import pkg from "pg";
const { Pool } = pkg;
import mercadopago from "mercadopago";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { GoogleGenAI } from "@google/genai";

// -------------------------
// CONFIG BASICA
// -------------------------

const app = express();
const port = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_secreta";

// -------------------------
// DATABASE
// -------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// -------------------------
// MERCADOPAGO
// -------------------------

const mpClient = new mercadopago.MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// -------------------------
// GEMINI
// -------------------------

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// -------------------------
// MIDDLEWARES
// -------------------------

app.use(cors());
app.use(express.json());

// -------------------------
// HELPERS
// -------------------------

async function getRoleIdByName(name) {
  const sql = `SELECT id FROM roles WHERE LOWER(nombre) = LOWER($1)`;
  const q = await pool.query(sql, [name]);
  return q.rows[0]?.id || null;
}

// -------------------------
// RUTAS
// -------------------------

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Backend operativo" });
});

// -----------------------------------------
// REGISTRO
// -----------------------------------------

app.post("/auth/register", async (req, res) => {
  try {
    const { nombre, email, password, role, telefono } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email y password requeridos" });
    }

    // ¿Existe usuario?
    const exist = await pool.query(
      "SELECT id FROM usuarios WHERE email = $1",
      [email]
    );

    if (exist.rows.length > 0) {
      return res.status(409).json({ error: "Correo ya registrado" });
    }

    const hash = await bcrypt.hash(password, 10);

    const roleName = role || "cliente";
    let roleId = await getRoleIdByName(roleName);
    if (!roleId) roleId = 1; // fallback

    const initialCredits = roleName === "artista" ? 3 : 0;

    const insert = await pool.query(
      `INSERT INTO usuarios (nombre, email, password, rol_id, fecha_registro, credits)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       RETURNING id, nombre, email, rol_id, credits`,
      [nombre, email, hash, roleId, initialCredits]
    );

    const user = insert.rows[0];

    if (roleName === "cliente" && telefono) {
      await pool.query(
        `INSERT INTO clientes (id, telefono, direccion)
         VALUES ($1, $2, '')
         ON CONFLICT (id) DO UPDATE SET telefono = EXCLUDED.telefono`,
        [user.id, telefono]
      );
    }

    // Token
    const token = jwt.sign(
      { userId: user.id, roleId: user.rol_id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ user, token });
  } catch (e) {
    console.error("❌ Error register:", e);
    res.status(500).json({ error: "Error en registro" });
  }
});

// -----------------------------------------
// LOGIN
// -----------------------------------------

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const q = await pool.query(
      `SELECT id, nombre, email, password, rol_id, credits
       FROM usuarios WHERE email = $1`,
      [email]
    );

    if (q.rows.length === 0) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const user = q.rows[0];
    const ok = await bcrypt.compare(password, user.password);

    if (!ok) return res.status(401).json({ error: "Credenciales inválidas" });

    delete user.password;

    const token = jwt.sign(
      { userId: user.id, roleId: user.rol_id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ user, token });
  } catch (e) {
    console.error("❌ Error login:", e);
    res.status(500).json({ error: "Error en login" });
  }
});

// -----------------------------------------
// CREAR SOLICITUD (CLIENTE)
// -----------------------------------------

app.post("/solicitudes", async (req, res) => {
  try {
    const {
      cliente_id,
      titulo,
      descripcion,
      tipo_musica,
      cantidad_ofertas,
      fecha_evento,
    } = req.body;

    const sql = `
      INSERT INTO solicitudes
      (cliente_id, titulo, descripcion, tipo_musica, fecha_evento, cantidad_ofertas, estado, fecha_creacion)
      VALUES ($1,$2,$3,$4,$5,$6,'abierta',NOW())
      RETURNING *`;

    const result = await pool.query(sql, [
      cliente_id,
      titulo,
      descripcion,
      tipo_musica,
      fecha_evento || null,
      cantidad_ofertas || 1,
    ]);

    res.json(result.rows[0]);
  } catch (e) {
    console.error("❌ Error creando solicitud:", e);
    res.status(500).json({ error: "Error al crear solicitud" });
  }
});

// -----------------------------------------
// LISTAR SOLICITUDES PARA ARTISTA
// -----------------------------------------

app.get("/solicitudes", async (req, res) => {
  try {
    const sql = `
      SELECT 
        s.*,
        COALESCE(d.cantidad_desbloqueos,0) AS desbloqueos
      FROM solicitudes s
      LEFT JOIN (
        SELECT solicitud_id, COUNT(*)::int AS cantidad_desbloqueos
        FROM desbloqueos
        GROUP BY solicitud_id
      ) d ON d.solicitud_id = s.id
      WHERE s.estado = 'abierta'
      ORDER BY s.fecha_creacion DESC`;

    const q = await pool.query(sql);
    res.json(q.rows);
  } catch (e) {
    console.error("❌ Error obteniendo solicitudes:", e);
    res.status(500).json({ error: "No se pudieron obtener solicitudes" });
  }
});

// -----------------------------------------
// DESBLOQUEAR SOLICITUD
// -----------------------------------------

app.post("/solicitudes/desbloquear", async (req, res) => {
  const client = await pool.connect();
  try {
    const { artista_id, solicitud_id } = req.body;

    await client.query("BEGIN");

    // 1) Solicitud
    const sol = await client.query(
      "SELECT * FROM solicitudes WHERE id=$1 FOR UPDATE",
      [solicitud_id]
    );

    if (sol.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Solicitud no encontrada" });
    }

    const solicitud = sol.rows[0];

    // 2) ¿Ya desbloqueada?
    const exists = await client.query(
      "SELECT 1 FROM desbloqueos WHERE solicitud_id=$1 AND artista_id=$2",
      [solicitud_id, artista_id]
    );

    if (exists.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Ya la desbloqueaste" });
    }

    // 3) Créditos
    const art = await client.query(
      "SELECT id, credits FROM usuarios WHERE id=$1 FOR UPDATE",
      [artista_id]
    );

    if (art.rows[0].credits <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Sin créditos suficientes" });
    }

    // 4) Insertar desbloqueo
    await client.query(
      "INSERT INTO desbloqueos (solicitud_id, artista_id, fecha) VALUES ($1,$2,NOW())",
      [solicitud_id, artista_id]
    );

    // 5) Descontar crédito
    const newCredits = art.rows[0].credits - 1;
    await client.query("UPDATE usuarios SET credits=$1 WHERE id=$2", [
      newCredits,
      artista_id,
    ]);

    await client.query("COMMIT");

    res.json({ ok: true, nuevosCreditos: newCredits });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Error desbloquear:", e);
    res.status(500).json({ error: "Error al desbloquear" });
  } finally {
    client.release();
  }
});

// -----------------------------------------
// MERCADOPAGO
// -----------------------------------------

app.post("/create_preference", async (req, res) => {
  try {
    const { title, quantity, price } = req.body;

    const pref = new mercadopago.Preference(mpClient);
    const result = await pref.create({
      body: {
        items: [
          {
            title,
            quantity,
            unit_price: price,
            currency_id: "CLP",
          },
        ],
      },
    });

    res.json({ id: result.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error con MercadoPago" });
  }
});

// -----------------------------------------
// GEMINI
// -----------------------------------------

app.post("/api/gemini", async (req, res) => {
  try {
    const { prompt } = req.body;

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    res.json({ text: result.text });
  } catch (e) {
    console.error("❌ Gemini error:", e);
    res.status(500).json({ error: "Gemini falló" });
  }
});

// -----------------------------------------
// START SERVER
// -----------------------------------------

app.listen(port, () => {
  console.log(`🔥 Backend escuchando en http://localhost:${port}`);
});


