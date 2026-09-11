const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Vehicle = require('../models/Vehicle');
const VehicleTransaction = require('../models/VehicleTransaction');
const VehicleStop = require('../models/VehicleStop');
const VehicleRoutePoint = require('../models/VehicleRoutePoint');
const User = require('../models/User'); 

const FLESPI_TOKEN = '933gcAbczGluPERbGkm0ktw72AEA829Jnf1pEEhO8dFjRtJXRfoY2ejMgNkxafb6';

async function sendFlespiCommand(flespiId, action) {
    if (!flespiId) return;
    try {
        const cleanId = String(flespiId).trim();
        const cmdText = action === 'off' ? 'setdigout 1' : 'setdigout 0';
        const payload = [{
            "name": "custom",
            "max_attempts": 3,
            "priority": 0,
            "properties": { "text": cmdText }
        }];

        const response = await fetch(`https://flespi.io/gw/devices/${cleanId}/commands-queue`, {
            method: 'POST',
            headers: {
                'Authorization': `FlespiToken ${FLESPI_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        console.log(`[FLESPI] 'setdigout' (value: ${action === 'off'}) sent to device ${flespiId}. Response:`, data);
    } catch (e) {
        console.error('[FLESPI] Error sending command:', e);
    }
}

async function getVehicleSpeed(flespiId) {
    if (!flespiId) return 0;
    try {
        const cleanId = String(flespiId).trim();
        const response = await fetch(`https://flespi.io/gw/devices/${cleanId}/telemetry/position.speed`, {
            headers: { 'Authorization': `FlespiToken ${FLESPI_TOKEN}` }
        });
        const data = await response.json();
        if (data && data.result && data.result.length > 0 && data.result[0].telemetry && data.result[0].telemetry['position.speed']) {
            return data.result[0].telemetry['position.speed'].value || 0;
        }
        return 0;
    } catch (e) {
        return 0;
    }
}

router.get('/api/maps-key', (req, res) => {
    res.json({ key: process.env.api_maps || '38add3dbbf81f2d79d8472ee09de7f4e660955e988f72d010a428ba4366bed3d' });
});

router.get('/api/vehicles', async (req, res) => {
    try {
        const vehicles = await Vehicle.aggregate([
            { $lookup: { from: "vehiclestops", localField: "currentStopId", foreignField: "_id", as: "currentStopData" } },
            { $unwind: { path: "$currentStopData", preserveNullAndEmptyArrays: true } },
            { $addFields: { equipmentCount: { $size: { $ifNull: ["$equipmentPhotos", []] } }, docsCount: { $size: { $ifNull: ["$documentosVehiculo", []] } }, currentStopStartTime: "$currentStopData.startTime" } },
            { $project: { lastDamageReport: 0, equipmentPhotos: 0, documentosVehiculo: 0, currentStopData: 0 } },
            { $sort: { createdAt: -1 } }
        ]);
        res.json(vehicles);
    } catch (e) {
        res.status(500).json({ error: 'Error obteniendo vehículos.' });
    }
});

router.get('/api/vehicles/:id/photos', async (req, res) => {
    try {
        const v = await Vehicle.findById(req.params.id).select('equipmentPhotos documentosVehiculo');
        if (!v) return res.status(404).json({ error: 'Vehículo no encontrado' });
        res.json({ equipmentPhotos: v.equipmentPhotos, documentosVehiculo: v.documentosVehiculo });
    } catch (e) {
        res.status(500).json({ error: 'Error obteniendo fotos del vehículo' });
    }
});

router.get('/api/vehicles/:id', async (req, res) => {
    try {
        const v = await Vehicle.findById(req.params.id);
        if (!v) return res.status(404).json({ error: 'No encontrado' });
        res.json(v);
    } catch (e) {
        res.status(500).json({ error: 'Error obteniendo vehículo individual.' });
    }
});

router.get('/api/vehicles/:id/last-loan', async (req, res) => {
    try {
        const tx = await VehicleTransaction.findOne({ vehicleId: req.params.id, tipoMovimiento: 'Préstamo' }).sort({ createdAt: -1 });
        res.json(tx || {});
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
});

router.post('/api/vehicles', async (req, res) => {
    try {
        const { marca, modelo, color, placas, bitacoraEsperada, equipmentPhotos, documentosVehiculo, imei, gpsModel, flespiId } = req.body;
        if (!marca || !modelo || !placas) return res.status(400).json({ error: 'Marca, modelo y placas son obligatorios.' });

        const newVehicle = new Vehicle({ marca, modelo, color, placas, bitacoraEsperada, equipmentPhotos, documentosVehiculo, imei, gpsModel, flespiId });
        await newVehicle.save();
        res.status(201).json(newVehicle);
    } catch (e) {
        res.status(500).json({ error: 'Error interno registrando vehículo.' });
    }
});

router.put('/api/vehicles/:id', async (req, res) => {
    try {
        const v = await Vehicle.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });
        if (!v) return res.status(404).json({ error: 'No encontrado' });
        res.json(v);
    } catch (e) {
        res.status(500).json({ error: 'Error interno.' });
    }
});

router.delete('/api/vehicles/:id', async (req, res) => {
    try {
        await Vehicle.findByIdAndDelete(req.params.id);
        res.json({ message: 'Eliminado.' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno.' });
    }
});

router.post('/api/vehicles/:id/ghost', async (req, res) => {
    try {
        const v = await Vehicle.findById(req.params.id);
        if (!v) return res.status(404).json({error: 'No encontrado'});
        v.ghostMode = !v.ghostMode;
        await v.save();
        res.json({ ghostMode: v.ghostMode });
    } catch(e) {
        res.status(500).json({error: 'Error interno.'});
    }
});

router.post('/api/vehicles/:id/loan', async (req, res) => {
    try {
        const { userId, userName, notas, bitacoraRevisada, imgReporteDanos, checklist, checklistNotas, proyectoId } = req.body;
        const vehicle = await Vehicle.findById(req.params.id);
        if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado.' });
        if (vehicle.estado !== 'Disponible') return res.status(400).json({ error: 'El vehículo no está disponible.' });

        if (vehicle.flespiId) {
            const speed = await getVehicleSpeed(vehicle.flespiId);
            if (speed > 3) {
                return res.status(400).json({ error: `Operación cancelada: El vehículo está en movimiento (${speed} km/h) y no puede ser bloqueado.` });
            }
            sendFlespiCommand(vehicle.flespiId, 'off').catch(console.error);
        }

        vehicle.estado = 'Pendiente de Confirmación';
        vehicle.currentUserId = userId;
        vehicle.currentUserName = userName;
        vehicle.encendido = false;
        vehicle.destinoSugeridoCRM = '';
        await vehicle.save();

        const tx = new VehicleTransaction({
            vehicleId: vehicle._id,
            userId,
            userName,
            proyectoId,
            tipoMovimiento: 'Préstamo',
            notas,
            bitacoraRevisada,
            imgReporteDanos,
            checklist,
            checklistNotas,
            estadoConfirmacion: 'Pendiente'
        });
        await tx.save();

        const io = req.app.get('io');
        if (io) io.emit('vehicle_updated', vehicle);

        res.status(200).json({ message: 'Vehículo en proceso de asignación.', transaction: tx });
    } catch (e) {
        res.status(500).json({ error: 'Error interno asignando.' });
    }
});

router.post('/api/vehicles/:id/return', async (req, res) => {
    try {
        const { userId, userName, notas, bitacoraRevisada, imgReporteDanos, kilometrajeActual, checklist, checklistNotas, proyectoId } = req.body;
        const vehicle = await Vehicle.findById(req.params.id);
        if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado.' });
        if (vehicle.estado !== 'Prestado' && vehicle.estado !== 'Pendiente de Confirmación') return res.status(400).json({ error: 'El vehículo no está prestado ni pendiente actualmente.' });

        if (vehicle.encendido === false && vehicle.flespiId) {
            sendFlespiCommand(vehicle.flespiId, 'on').catch(console.error);
        }

        vehicle.estado = 'Disponible';
        vehicle.currentUserId = null;
        vehicle.currentUserName = null;
        vehicle.encendido = true;
        if (kilometrajeActual) vehicle.kilometrajeActual = kilometrajeActual;
        if (imgReporteDanos) vehicle.lastDamageReport = imgReporteDanos;
        await vehicle.save();

        const tx = new VehicleTransaction({
            vehicleId: vehicle._id,
            userId, userName, proyectoId,
            tipoMovimiento: 'Devolución',
            notas, bitacoraRevisada, imgReporteDanos,
            kilometraje: kilometrajeActual, checklist, checklistNotas
        });
        await tx.save();

        VehicleTransaction.findOne({ vehicleId: vehicle._id, userId: userId, tipoMovimiento: 'Préstamo' }).sort({ fecha: -1 }).then(prestamoTx => {
            if (prestamoTx) {
                prestamoTx.fechaDevolucion = new Date();
                prestamoTx.save().catch(console.error);
            }
        }).catch(console.error);

        const io = req.app.get('io');
        if (io) io.emit('vehicle_updated', vehicle);

        res.status(200).json({ message: 'Vehículo devuelto exitosamente.', transaction: tx });
    } catch (e) {
        res.status(500).json({ error: 'Error interno devolviendo.' });
    }
});

router.post('/api/vehicles/:id/request-return', async (req, res) => {
    try {
        const vehicle = await Vehicle.findById(req.params.id);
        if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado.' });
        if (vehicle.estado !== 'Prestado' && vehicle.estado !== 'Pendiente de Confirmación') return res.status(400).json({ error: 'El vehículo no está prestado actualmente.' });

        const prestamoTx = await VehicleTransaction.findOne({
            vehicleId: vehicle._id,
            userId: req.body.userId || vehicle.currentUserId,
            tipoMovimiento: 'Préstamo'
        }).sort({ fecha: -1 });

        if (prestamoTx) {
            prestamoTx.fechaSolicitudDevolucion = new Date();
            await prestamoTx.save();
            res.json({ success: true, message: 'Solicitud enviada a los administradores.' });
        } else {
            res.status(404).json({ error: 'No se encontró el préstamo activo para este vehículo.' });
        }
    } catch(e) {
        res.status(500).json({ error: 'Error al solicitar devolución.', detail: e.message });
    }
});

router.post('/api/vehicles/:id/engine', async (req, res) => {
    try {
        const { action, force } = req.body;
        const vehicle = await Vehicle.findById(req.params.id);
        if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado.' });

        if (action === 'off') {
            if (!force && vehicle.flespiId) {
                const speed = await getVehicleSpeed(vehicle.flespiId);
                if (speed > 3) {
                    return res.status(400).json({ error: `Operación cancelada: El vehículo está en movimiento (${speed} km/h).` });
                }
            }
            vehicle.encendido = false;
        } else if (action === 'on') {
            if (vehicle.estado === 'Pendiente de Confirmación' && !force) {
                return res.status(400).json({ error: 'Debes aceptar la asignación del vehículo antes de poder encenderlo.' });
            }
            vehicle.encendido = true;
        }

        if (vehicle.flespiId) {
            await sendFlespiCommand(vehicle.flespiId, vehicle.encendido ? 'on' : 'off');
        }
        await vehicle.save();

        const io = req.app.get('io');
        if (io) io.emit('vehicle_updated', vehicle);

        res.status(200).json({ message: vehicle.encendido ? 'Bloqueo desactivado (Restaurado).' : 'Bloqueo activado (Motor cortado).', encendido: vehicle.encendido });
    } catch (e) {
        res.status(500).json({ error: 'Error interno cambiando estado del motor.' });
    }
});

router.post('/api/vehicles/:id/gasoline', async (req, res) => {
    try {
        const { userId, userName, gasolinaMonto, gasolinaLitros, gasolinaFoto, kilometrajeActual } = req.body;
        const vehicle = await Vehicle.findById(req.params.id);
        if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado.' });

        if (kilometrajeActual) {
            vehicle.kilometrajeActual = kilometrajeActual;
            await vehicle.save();
        }

        const tx = new VehicleTransaction({
            vehicleId: vehicle._id,
            userId, userName,
            tipoMovimiento: 'Gasolina',
            gasolinaMonto, gasolinaLitros, gasolinaFoto,
            kilometraje: kilometrajeActual
        });
        await tx.save();
        res.status(200).json({ message: 'Gasolina registrada exitosamente.' });
    } catch (e) {
        res.status(500).json({ error: 'Error registrando gasolina.' });
    }
});

router.post('/api/vehicles/:id/maintenance', async (req, res) => {
    try {
        const { notas, mantenimientoCosto, mantenimientoPiezas, mantenimientoTaller, fecha } = req.body;
        const vehicle = await Vehicle.findById(req.params.id);
        if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado.' });

        const tx = new VehicleTransaction({
            vehicleId: vehicle._id,
            userId: 'ADMIN',
            userName: 'Administrador',
            tipoMovimiento: 'Mantenimiento',
            notas,
            mantenimientoCosto,
            mantenimientoPiezas,
            mantenimientoTaller,
            fecha: fecha ? new Date(fecha) : new Date()
        });
        await tx.save();
        res.status(200).json({ message: 'Mantenimiento registrado exitosamente.' });
    } catch (e) {
        res.status(500).json({ error: 'Error registrando mantenimiento.' });
    }
});

router.get('/api/users/:id/vehicles', async (req, res) => {
    try {
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const txs = await VehicleTransaction.find({
            userId: req.params.id,
            fecha: { $gte: oneYearAgo.toISOString() }
        }).select('-firma -firmaUsuario -gasolinaFoto -imgReporteDanos -checklistNotas').sort({ fecha: -1 });

        const vehicleIds = [...new Set(txs.map(t => t.vehicleId))].filter(Boolean);
        const vehicles = await Vehicle.find({ _id: { $in: vehicleIds } }).select('marca modelo placas color').lean();
        const vehicleMap = {};
        vehicles.forEach(v => vehicleMap[v._id] = v);

        const hydratedTxs = txs.map(tx => {
            const obj = tx.toObject();
            obj.vehicleId = vehicleMap[tx.vehicleId] || { marca: 'Desconocido', modelo: '', placas: tx.vehicleId };
            return obj;
        });

        const currentVehicles = await Vehicle.find({ currentUserId: req.params.id });
        res.json({ currentVehicles, history: hydratedTxs });
    } catch (e) {
        res.status(500).json({ error: 'Error obteniendo historial de vehículo.' });
    }
});

router.get('/api/vehicles/:id/history-route', async (req, res) => {
    try {
        const { id } = req.params;
        let query = { vehicleId: id };
        
        if (req.query.date) {
            const startOfDay = new Date(req.query.date + 'T06:00:00.000Z');
            const endOfDay = new Date(startOfDay);
            endOfDay.setDate(endOfDay.getDate() + 1);
            endOfDay.setMilliseconds(endOfDay.getMilliseconds() - 1);
            query.timestamp = { $gte: startOfDay, $lte: endOfDay };
        } else {
            const days = parseInt(req.query.days) || 7;
            const dateLimit = new Date();
            dateLimit.setDate(dateLimit.getDate() - days);
            query.timestamp = { $gte: dateLimit };
        }

        const route = await VehicleRoutePoint.find(query).sort({ timestamp: 1 });
        res.json(route);
    } catch (e) {
        res.status(500).json({ error: 'Error obteniendo historial de ruta.' });
    }
});

router.get('/api/vehicles/:id/history-stops', async (req, res) => {
    try {
        const { id } = req.params;
        let query = { vehicleId: id };
        
        if (req.query.date) {
            const startOfDay = new Date(req.query.date + 'T06:00:00.000Z');
            const endOfDay = new Date(startOfDay);
            endOfDay.setDate(endOfDay.getDate() + 1);
            endOfDay.setMilliseconds(endOfDay.getMilliseconds() - 1);
            query.startTime = { $gte: startOfDay, $lte: endOfDay };
        } else {
            const days = parseInt(req.query.days) || 7;
            const dateLimit = new Date();
            dateLimit.setDate(dateLimit.getDate() - days);
            query.createdAt = { $gte: dateLimit };
        }

        const stops = await VehicleStop.find(query).sort({ startTime: -1 });
        res.json(stops);
    } catch (e) {
        res.status(500).json({ error: 'Error obteniendo historial de paradas.' });
    }
});

router.get('/api/vehicles/:id/history', async (req, res) => {
    try {
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const txs = await VehicleTransaction.find({
            vehicleId: req.params.id,
            fecha: { $gte: oneYearAgo.toISOString() }
        }).select('-firma -firmaUsuario -gasolinaFoto -imgReporteDanos -checklistNotas').sort({ fecha: -1 });

        const vehicle = await Vehicle.findById(req.params.id).select('marca modelo placas color').lean();
        const hydratedTxs = txs.map(tx => {
            const obj = tx.toObject();
            obj.vehicleId = vehicle || { marca: 'Desconocido', modelo: '', placas: req.params.id };
            return obj;
        });

        res.json({ history: hydratedTxs });
    } catch (e) {
        res.status(500).json({ error: 'Error obteniendo historial del vehículo.' });
    }
});

router.get('/api/vehicle-transaction/:id/photos', async (req, res) => {
    try {
        const tx = await VehicleTransaction.findById(req.params.id).select('gasolinaFoto imgReporteDanos');
        if (!tx) return res.status(404).json({ error: 'Transacción no encontrada' });
        res.json({ gasolinaFoto: tx.gasolinaFoto, imgReporteDanos: tx.imgReporteDanos });
    } catch (e) {
        res.status(500).json({ error: 'Error obteniendo fotos de transacción.' });
    }
});

router.get('/api/vehicle-transactions/all', async (req, res) => {
    try {
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const txs = await VehicleTransaction.find({
            fecha: { $gte: oneYearAgo.toISOString() },
            tipoMovimiento: { $in: ['Préstamo', 'Devolución', 'Devolucion', 'Salida'] }
        }).select('-firma -firmaUsuario -gasolinaFoto -imgReporteDanos').sort({ fecha: -1 });

        const vehicleIds = [...new Set(txs.map(t => t.vehicleId))].filter(Boolean);
        const vehiclesList = await Vehicle.find({ _id: { $in: vehicleIds } }).select('marca modelo placas color').lean();
        const vehicleMap = {};
        vehiclesList.forEach(v => vehicleMap[v._id] = v);

        const hydratedTxs = txs.map(tx => {
            const obj = tx.toObject();
            obj.vehicleId = vehicleMap[tx.vehicleId] || { marca: 'Desconocido', modelo: '', placas: tx.vehicleId };
            return obj;
        });

        res.json({ history: hydratedTxs });
    } catch (e) {
        res.status(500).json({ error: 'Error obteniendo historial general.' });
    }
});

router.put('/api/tracking/vehiculos/swap-crm', async (req, res) => {
    try {
        const { oldVehicleId, newVehicleId, crmActividadId } = req.body;
        if (!oldVehicleId || !newVehicleId || !crmActividadId) return res.status(400).json({ error: 'Faltan parámetros' });

        const oldVehicle = await Vehicle.findById(oldVehicleId);
        if (!oldVehicle) return res.status(404).json({ error: 'Vehículo original no encontrado' });

        const label = oldVehicle.destinoSugeridoCRM;
        const proyectoId = oldVehicle.crmProyectoId;

        oldVehicle.destinoSugeridoCRM = '';
        oldVehicle.crmActividadId = null;
        oldVehicle.crmProyectoId = null;
        await oldVehicle.save();

        const newVehicle = await Vehicle.findById(newVehicleId);
        if (!newVehicle) return res.status(404).json({ error: 'Vehículo nuevo no encontrado' });
        newVehicle.destinoSugeridoCRM = label;
        newVehicle.crmActividadId = crmActividadId;
        newVehicle.crmProyectoId = proyectoId;
        await newVehicle.save();

        const db = mongoose.connection.db;
        await db.collection('crmactividads').updateOne(
            { _id: crmActividadId }, { $pull: { vehiculosAsignados: oldVehicleId } }
        );
        await db.collection('crmactividads').updateOne(
            { _id: crmActividadId }, { $addToSet: { vehiculosAsignados: newVehicleId } }
        );
        if (proyectoId && proyectoId !== 'null') {
            await db.collection('crmproyectos').updateOne(
                { _id: proyectoId }, { $pull: { vehiculosAsignados: oldVehicleId } }
            );
            await db.collection('crmproyectos').updateOne(
                { _id: proyectoId }, { $addToSet: { vehiculosAsignados: newVehicleId } }
            );
        }

        res.json({ message: 'Vehículo reasignado con éxito', oldVehicle, newVehicle });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// FIX C: Buffer de diagnóstico — guarda los últimos 10 payloads recibidos de Flespi
// Portado del server.js original. Ver en: GET /api/flespi/debug
const flespiDebugLog = [];

router.get('/api/flespi/debug', (req, res) => {
    res.json({ total: flespiDebugLog.length, last10: flespiDebugLog });
});

router.post('/api/flespi/webhook', async (req, res) => {
    // Responder 200 inmediatamente a Flespi para evitar timeouts
    res.status(200).send('OK');

    try {
        let data = req.body;

        // Guardar en buffer de diagnóstico (últimos 10)
        flespiDebugLog.unshift({ receivedAt: new Date().toISOString(), body: data });
        if (flespiDebugLog.length > 10) flespiDebugLog.pop();
        if (!Array.isArray(data)) data = [data];

        for (const msg of data) {
            // FIX 3: try/catch por mensaje individual — un mensaje malo no mata el batch completo
            try {
                const imei = msg.ident;
                const lat = msg['position.latitude'];
                const lng = msg['position.longitude'];
                const speed = msg['position.speed'] || msg['obd.vehicle.speed'] || msg['can.vehicle.speed'] || 0;
                const direction = msg['position.direction'] || 0;
                const ignition = msg['engine.ignition.status'] !== undefined ? (msg['engine.ignition.status'] || speed > 0) : (speed > 0);

                const engineRPM = msg['can.engine.rpm'] || msg['obd.engine.rpm'] || 0;
                const batteryVoltage = msg['battery.voltage'] || 0;
                const externalVoltage = msg['external.powersource.voltage'] || msg['can.vehicle.battery.level'] || 0;
                const fuelLevel = msg['can.fuel.level'] || msg['obd.fuel.level'] || 0;
                const engineTemp = msg['can.engine.temperature'] || msg['obd.engine.temperature'] || 0;
                const mileage = msg['can.vehicle.mileage'] || msg['obd.vehicle.mileage'] || 0;
                const dtcCount = msg['can.dtc.count'] || msg['obd.dtc.count'] || 0;

                const timestamp = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();

                if (!imei || lat === undefined || lng === undefined) continue;

                const vehicle = await Vehicle.findOne({ imei: String(imei) });
                if (!vehicle) {
                    console.warn(`[FLESPI] IMEI desconocido: ${imei}`);
                    continue;
                }
                if (vehicle.ghostMode) continue;

                // FIX 1: rawData solo va a lastLocation, NO al historial.
                // Antes se guardaba rawData en cada entrada de locationHistory (100 entradas × objeto Flespi completo)
                // eso hacia crecer el documento de MongoDB hasta superar 16MB → vehicle.save() explotaba con error 500.
                const newLocForHistory = { lat, lng, speed, direction, ignition, engineRPM, batteryVoltage, externalVoltage, fuelLevel, engineTemp, mileage, dtcCount, timestamp };
                const newLocFull = { ...newLocForHistory, rawData: msg };

                const isMoving = speed > 3;

                // FIX 2: currentStopId se guarda como String explícito.
                // stop._id es ObjectId pero el schema lo define como String — sin .toString() 
                // puede causar errores de casteo en findById posteriores.
                if (!isMoving && !vehicle.currentStopId) {
                    const stop = new VehicleStop({ vehicleId: vehicle._id, userId: vehicle.currentUserId, userName: vehicle.currentUserName, lat, lng, startTime: timestamp });
                    await stop.save();
                    vehicle.currentStopId = stop._id.toString();
                } else if (isMoving && vehicle.currentStopId) {
                    const stop = await VehicleStop.findById(vehicle.currentStopId);
                    if (stop) {
                        stop.endTime = timestamp;
                        stop.durationMinutes = Math.max(0, Math.round((timestamp - stop.startTime) / 60000));
                        await stop.save();
                    }
                    vehicle.currentStopId = null;
                }

                vehicle.lastLocation = newLocFull;

                VehicleRoutePoint.create({
                    vehicleId: vehicle._id, lat, lng, speed, ignition, engineRPM, batteryVoltage, externalVoltage, fuelLevel, engineTemp, mileage, dtcCount, timestamp
                }).catch(err => console.error('[FLESPI] Error guardando RoutePoint:', err.message));

                if (!vehicle.locationHistory) vehicle.locationHistory = [];
                vehicle.locationHistory.push(newLocForHistory); // sin rawData
                if (vehicle.locationHistory.length > 100) vehicle.locationHistory = vehicle.locationHistory.slice(-100);

                await vehicle.save();

                let currentStopStartTime = null;
                if (vehicle.currentStopId) {
                    const activeStop = await VehicleStop.findById(vehicle.currentStopId);
                    if (activeStop) currentStopStartTime = activeStop.startTime;
                }

                const io = req.app.get('io');
                if (io) {
                    io.emit('vehicle_location_update', {
                        vehicleId: vehicle._id, gpsModel: vehicle.gpsModel, imei, lat, lng, speed, direction, ignition,
                        engineRPM, batteryVoltage, externalVoltage, fuelLevel, engineTemp, mileage, dtcCount, timestamp,
                        rawData: msg, route: vehicle.locationHistory, currentStopStartTime
                    });
                }

            } catch (msgErr) {
                // Log detallado por mensaje — así en los logs de Render ves exactamente qué falló
                console.error(`[FLESPI] Error procesando mensaje (IMEI: ${msg.ident}):`, msgErr.name, msgErr.message);
            }
        }
    } catch (e) {
        console.error('[FLESPI] Error general en webhook:', e.name, e.message);
    }
});

// Flespi hace GET al webhook para verificar conectividad del stream
// Sin este handler devuelve 404 que aparece como error en el panel de Flespi
router.get('/api/flespi/webhook', (req, res) => {
    res.status(200).send('Flespi webhook activo');
});

module.exports = router;
