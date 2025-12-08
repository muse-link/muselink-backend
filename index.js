// Cargar variables de entorno desde .env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
const port = process.env.PORT || 3000;

// Cliente de Mercado Pago usando el Access Token desde variables de entorno
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN, // Debes tener esto en .env
});

// Middlewares
app.use(cors());
app.use(express.json());

// Endpoint simple para probar que el backend funciona
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'MuseLink backend funcionando ✅' });
});

// Endpoint que usa el frontend para crear la preferencia de pago
app.post('/create_preference', async (req, res) => {
  try {
    const { title, quantity, price } = req.body;

    console.log('📩 Solicitud recibida desde el frontend:', {
      title,
      quantity,
      price,
    });

    const body = {
      items: [
        {
          title: title || 'Pack de créditos',
          quantity: Number(quantity) || 1,
          unit_price: Number(price),
          currency_id: 'CLP',
        },
      ],
      // Por ahora SIN back_urls ni auto_return para evitar errores
    };

    const preference = new Preference(client);
    const result = await preference.create({ body });

    console.log('✅ Preferencia creada con ID:', result.id);

    res.json({ id: result.id });
  } catch (error) {
    console.error('❌ Error creando preferencia en Mercado Pago:', error);
    res.status(500).json({ error: 'Error al crear preferencia' });
  }
});

// Levantar servidor
app.listen(port, () => {
  console.log(`Servidor MercadoPago escuchando en http://localhost:${port}`);
});