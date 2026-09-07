const express = require('express');
const PushSubscription = require('../models/PushSubscription');
const { verifyToken } = require('../middleware/auth');
const webpush = require('web-push');

const router = express.Router();

const publicVapidKey = process.env.VAPID_PUBLIC_KEY || 'BNBpK_UrcsBPCovKGojxGcfSYOEcgW_ILtH7_xrBh3jpTh-96K7_ljPQ2BOH6hBuoWZAwWMI74VfqVfH5qu89DE';
const privateVapidKey = process.env.VAPID_PRIVATE_KEY || 'ubos1eC5dt6b42GMYftyF42fibH6aRsFjdxcbd2rNS8';

webpush.setVapidDetails(
  'mailto:contacto@example.com',
  publicVapidKey,
  privateVapidKey
);

router.get('/vapidPublicKey', (req, res) => {
  res.json({ publicKey: publicVapidKey });
});

router.post('/subscribe', verifyToken, async (req, res) => {
  const subscription = req.body;
  try {
    await PushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      { 
        user: req.user.id,
        endpoint: subscription.endpoint,
        keys: subscription.keys
      },
      { upsert: true, new: true }
    );
    res.status(201).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar suscripción' });
  }
});

const sendPushNotification = async (userId, payload) => {
  try {
    const subscriptions = await PushSubscription.find({ user: userId });
    const promises = subscriptions.map(sub => 
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: sub.keys
        }, 
        JSON.stringify(payload)
      ).catch(async err => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log('Suscripción expirada, eliminando...');
          await PushSubscription.findByIdAndDelete(sub._id);
        } else {
          console.error('Error enviando push:', err);
        }
      })
    );
    await Promise.all(promises);
  } catch(err) {
    console.error('Error general enviando push:', err);
  }
};

module.exports = { router, webpush, sendPushNotification };
