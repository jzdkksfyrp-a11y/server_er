const { MongoClient } = require('mongodb');
const dns = require('dns');

// Forzar el uso del DNS 8.8.8.8
dns.setServers(['8.8.8.8']);

// URI de conexión proporcionada
const uri = "mongodb+srv://jarvis:Hola2025@cluster0.jih3lub.mongodb.net/naisata_db?appName=Cluster0";

async function limpiarBaseDeDatos() {
  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log("Conectado correctamente a MongoDB.");
    
    const db = client.db('naisata_db');
    
    // 1. Eliminar todas las bobinas (asumiendo que la colección se llama 'bobinas')
    const bobinasCol = db.collection('bobinas'); 
    const resultadoBobinas = await bobinasCol.deleteMany({});
    console.log(`${resultadoBobinas.deletedCount} registros de 'bobinas' eliminados.`);
    
    // 2. Eliminar al usuario 'mateo' (asumiendo que la colección se llama 'usuarios')
    // Si tu colección se llama de otra forma, cambia 'usuarios' por el nombre correcto (ej. 'users')
    const usuariosCol = db.collection('usuarios');
    const resultadoUsuarios = await usuariosCol.deleteOne({ usuario: 'mateo' }); 
    // Nota: si el campo se llama 'nombre', 'username' o 'email', ajusta el filtro arriba.
    console.log(`Usuario 'mateo' eliminado. Cantidad: ${resultadoUsuarios.deletedCount}`);
    
  } catch (error) {
    console.error("Error al ejecutar la operación:", error);
  } finally {
    await client.close();
    console.log("Conexión cerrada.");
  }
}

limpiarBaseDeDatos().catch(console.error);
