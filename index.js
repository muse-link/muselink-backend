// Cargar variables de entorno desde .env
require('dotenv').config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,   // En Render debe existir
  ssl: { rejectUnauthorized: false }
});




const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference } = require('mercadopago');

// 👇 Nuevo SDK de Gemini compatible con CommonJS
const { GoogleGenAI } = require("@google/genai");

const app = express();
const port = process.env.PORT || 3000;

// Cliente de Mercado Pago
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// Middlewares
app.use(cors());
app.use(express.json());

// Endpoint simple
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'MuseLink backend funcionando ✅' });
});

// Crear preferencia de Mercado Pago
app.post('/create_preference', async (req, res) => {
  try {
    const { title, quantity, price } = req.body;

    const body = {
      items: [
        {
          title: title || 'Pack de créditos',
          quantity: Number(quantity) || 1,
          unit_price: Number(price),
          currency_id: 'CLP',
        },
      ],
    };

    const preference = new Preference(client);
    const result = await preference.create({ body });

    res.json({ id: result.id });
  } catch (error) {
    console.error('❌ Error creando preferencia en Mercado Pago:', error);
    res.status(500).json({ error: 'Error al crear preferencia' });
  }
});

// =====================================================
// 🚀 RUTA /api/gemini usando el nuevo cliente Google GenAI
// =====================================================

app.post("/api/gemini", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Falta el prompt" });
    }

    // Crear cliente AI con la API key
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    // Llamar a un modelo válido (NO usar 1.5)
    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash", // También sirve: "gemini-2.5-flash"
      contents: prompt,
    });

    const text = result.text;

    return res.json({ text });
  } catch (error) {
    console.error("❌ Error en /api/gemini:", error);
    return res.status(500).json({ error: "Error al generar respuesta con Gemini" });
  }
});


// =========================
//  RUTA PARA CREAR SOLICITUDES
// =========================
app.post("/solicitudes", async (req, res) => {
  try {
    const {
      cliente_id,
      titulo,
      descripcion,
      tipo_musica,
      cantidad_ofertas
    } = req.body;

    const result = await pool.query(
      `INSERT INTO solicitudes
       (cliente_id, titulo, descripcion, tipo_musica, fecha_evento, cantidad_ofertas, estado)
       VALUES ($1, $2, $3, $4, NULL, $5, 'abierta')
       RETURNING *`,
      [cliente_id, titulo, descripcion, tipo_musica, cantidad_ofertas]
    );

    return res.json(result.rows[0]);

  } catch (error) {
    console.error("❌ Error creando solicitud:", error);
    return res.status(500).json({ error: "Error al crear solicitud" });
  }
});




// Levantar servidor
app.listen(port, () => {
  console.log(`Servidor MercadoPago escuchando en http://localhost:${port}`);
});




