const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");
const { google } = require("googleapis");
const mysql = require("mysql2/promise");
const { PDFParse } = require("pdf-parse");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const PDF_DIR = path.join(__dirname, "pdfs");

if (!fs.existsSync(PDF_DIR)) {
  fs.mkdirSync(PDF_DIR);
}

let db;

async function conectarMySQL() {
  db = await mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "1234",
    database: "facturacion",
  });

  console.log("✅ MySQL conectado");
}

const credentials = JSON.parse(fs.readFileSync("credentials.json"));
const token = JSON.parse(fs.readFileSync("token.json"));

const { client_secret, client_id, redirect_uris } = credentials.installed;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

oAuth2Client.setCredentials(token);

const gmail = google.gmail({
  version: "v1",
  auth: oAuth2Client,
});

function obtenerAdjuntos(parts = []) {
  let adjuntos = [];

  for (const part of parts) {
    if (part.filename && part.body && part.body.attachmentId) {
      adjuntos.push(part);
    }

    if (part.parts) {
      adjuntos = adjuntos.concat(obtenerAdjuntos(part.parts));
    }
  }

  return adjuntos;
}

async function procesarPdf(rutaPdf) {
  const buffer = fs.readFileSync(rutaPdf);

  const parser = new PDFParse({ data: buffer });
  const pdfData = await parser.getText();

  const textoOriginal = pdfData.text || "";

  const texto = textoOriginal
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const fechaMatch = texto.match(
    /FECHA\s+DE\s+EMISION\s+(\d{2})[-\/](\d{2})[-\/](\d{4})/i
  );

  let fechaEmision = null;
let rucCliente = null;
let dniCliente = null;
  if (fechaMatch) {
    fechaEmision = `${fechaMatch[3]}-${fechaMatch[2]}-${fechaMatch[1]}`;
  }
// RUC del cliente: aparece después de la etiqueta RUC, no el RUC emisor
const rucClienteMatch =
  texto.match(/(?:SEÑOR|SENOR).*?RUC\s+(\d{11})/i) ||
  texto.match(/RUC\s+(\d{11})\s+DOC\.?\s*REF/i);

if (rucClienteMatch) {
  rucCliente = rucClienteMatch[1];
}

// DNI del cliente: puede venir como DOC.IDENTIDAD, DOC IDENTIDAD, DOC. IDENTIDAD
const dniClienteMatch =
  texto.match(/DOC\.?\s*IDENTIDAD\s+(\d{8})/i) ||
  texto.match(/DOC\.?\s*IDENT\.?\s+(\d{8})/i) ||
  texto.match(/DOCUMENTO\s+DE\s+IDENTIDAD\s+(\d{8})/i) ||
  texto.match(/DNI\s+(\d{8})/i);

if (dniClienteMatch) {
  dniCliente = dniClienteMatch[1];
}
  const rucEmisor =
    texto.match(/R\.?U\.?C\.?\s*(\d{11})/i)?.[1] ||
    texto.match(/\b(20\d{9})\b/)?.[1] ||
    null;

 const tipoDocumento =
  texto.match(/BOLETA\s+DE\s+VENTA\s+ELECTRONICA/i)?.[0] ||
  texto.match(/NOTA\s+DE\s+CREDITO\s+ELECTRONICA/i)?.[0] ||
  texto.match(/NOTA\s+DE\s+CREDITO/i)?.[0] ||
  texto.match(/FACTURA\s+ELECTRONICA/i)?.[0] ||
  texto.match(/BOLETA\s+ELECTRONICA/i)?.[0] ||
  null;

const numeroMatch =
  texto.match(/\b(BE\d{2})[-\s]*(\d{1,10})\b/i) ||
  texto.match(/\b(BC\d{2})[-\s]*(\d{1,10})\b/i) ||
  texto.match(/\b(FC\d{2})[-\s]*(\d{1,10})\b/i) ||
  texto.match(/\b(FE\d{2})[-\s]*(\d{1,10})\b/i) ||
  texto.match(/\b(F\d{3})[-\s]*(\d{1,10})\b/i) ||
  texto.match(/\b(B\d{3})[-\s]*(\d{1,10})\b/i);

  const serie = numeroMatch ? numeroMatch[1].toUpperCase() : null;
  const correlativo = numeroMatch ? numeroMatch[2] : null;
  const numero = serie && correlativo ? `${serie}-${correlativo}` : null;

  function normalizarMonto(valor) {
    if (!valor) return null;

    let limpio = valor.replace(/\s/g, "");

    if (limpio.includes(",") && limpio.includes(".")) {
      limpio = limpio.replace(/\./g, "").replace(",", ".");
    } else if (limpio.includes(",")) {
      limpio = limpio.replace(",", ".");
    }

    return limpio;
  }

  let total = null;

  const bloqueMatch = texto.match(
    /IMPORTE\s+TOTAL\s+((?:\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})(?:\s+|$)){1,10}/i
  );

  if (bloqueMatch) {
    const montos = bloqueMatch[1].match(
      /\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2}/g
    );

    if (montos && montos.length > 0) {
      total = normalizarMonto(montos[montos.length - 1]);
    }
  }

  if (!total || Number(total) === 0) {
    const montos = texto.match(
      /\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2}/g
    );

    if (montos && montos.length > 0) {
      const montosValidos = montos
        .map(normalizarMonto)
        .map(Number)
        .filter((n) => !isNaN(n) && n > 0);

      if (montosValidos.length > 0) {
        total = Math.max(...montosValidos).toFixed(2);
      }
    }
  }

 return {
  tipoDocumento,
  serie,
  correlativo,
  numero,
  ruc: rucEmisor,
  rucEmisor,
  rucCliente,
  dniCliente,
  total,
  fechaEmision,
  texto,
};
}

async function obtenerMensajesGmail(query, usarPaginacion = false) {
  let mensajes = [];
  let pageToken = null;

  do {
    const correos = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: usarPaginacion ? 500 : 50,
      pageToken,
    });

    mensajes = mensajes.concat(correos.data.messages || []);
    pageToken = usarPaginacion ? correos.data.nextPageToken || null : null;
  } while (pageToken);

  return mensajes;
}

async function sincronizarGmailBase(query, usarPaginacion = false) {
  const mensajes = await obtenerMensajesGmail(query, usarPaginacion);

  console.log("Correos encontrados:", mensajes.length);

  let procesados = 0;
  let omitidos = 0;
  let errores = 0;

  for (const message of mensajes) {
    const mensaje = await gmail.users.messages.get({
      userId: "me",
      id: message.id,
    });

    const parts = mensaje.data.payload.parts || [];
    const adjuntos = obtenerAdjuntos(parts);

    for (const adjunto of adjuntos) {
      const filenameLower = adjunto.filename.toLowerCase();

      if (!filenameLower.endsWith(".pdf") && !filenameLower.endsWith(".xml")) {
        continue;
      }

      try {
        const esPdf = filenameLower.endsWith(".pdf");
        const esXml = filenameLower.endsWith(".xml");

        const adjuntoUid = crypto
          .createHash("sha256")
          .update(`${message.id}-${adjunto.filename}`)
          .digest("hex");

        const attachment = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: message.id,
          id: adjunto.body.attachmentId,
        });

        const data = attachment.data.data;

        if (!data) {
          throw new Error("Adjunto sin data");
        }

        const buffer = Buffer.from(data, "base64url");

        const nombreArchivoSeguro = adjunto.filename.replace(/[<>:"/\\|?*]/g, "_");
if (esXml) {
  const nombreXmlSeguro = adjunto.filename.replace(/[<>:"/\\|?*]/g, "_");

  const datosXml = extraerDatosClienteXml(buffer);

  const [xmlExiste] = await db.query(
    `SELECT id 
     FROM documentos 
     WHERE archivos_xml = ? 
     AND xml_data IS NOT NULL
     AND (ruc_cliente IS NOT NULL OR dni_cliente IS NOT NULL)`,
    [nombreXmlSeguro]
  );

  if (xmlExiste.length > 0) {
    omitidos++;
    console.log("⏭️ XML omitido, ya existe:", nombreXmlSeguro);
    continue;
  }

  const baseXml = nombreXmlSeguro.replace(/\.xml$/i, "");
  const nombrePdfRelacionado = `${baseXml}.pdf`;

  const [updateResult] = await db.query(
    `UPDATE documentos
     SET archivos_xml = ?,
         xml_data = ?,
         xml_mime = ?,
         ruc_cliente = ?,
         dni_cliente = ?
     WHERE archivo_pdf = ?`,
    [
      nombreXmlSeguro,
      buffer,
      "application/xml",
      datosXml.rucCliente,
      datosXml.dniCliente,
      nombrePdfRelacionado,
    ]
  );

  if (updateResult.affectedRows > 0) {
    console.log("✅ XML guardado:", nombreXmlSeguro);
    console.log("RUC cliente:", datosXml.rucCliente);
    console.log("DNI cliente:", datosXml.dniCliente);
    procesados++;
  } else {
    console.log("⚠️ XML detectado, pero aún no existe su PDF:", nombreXmlSeguro);
    omitidos++;
  }

  continue;
}

        if (esPdf) {
          const [pdfExiste] = await db.query(
            "SELECT id FROM documentos WHERE pdf_uid = ?",
            [adjuntoUid]
          );

          if (pdfExiste.length > 0) {
            omitidos++;
            console.log("⏭️ PDF omitido, ya existe:", nombreArchivoSeguro);
            continue;
          }

          if (!buffer.length || buffer.slice(0, 4).toString() !== "%PDF") {
            throw new Error("El archivo descargado no parece ser PDF válido");
          }

          const rutaPdf = path.join(PDF_DIR, nombreArchivoSeguro);

          fs.writeFileSync(rutaPdf, buffer);

          const datos = await procesarPdf(rutaPdf);

      const [result] = await db.query(
  `INSERT INTO documentos 
  (
    pdf_uid,
    tipo_documento,
    serie,
    correlativo,
    numero,
    ruc,
    ruc_emisor,
    ruc_cliente,
    dni_cliente,
    monto,
    fecha_emision,
    archivo_pdf,
    pdf_data,
    pdf_mime,
    gmail_message_id,
    gmail_attachment_id
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    adjuntoUid,
    datos.tipoDocumento,
    datos.serie,
    datos.correlativo,
    datos.numero,
    datos.ruc,
    datos.rucEmisor,
    datos.rucCliente,
    datos.dniCliente,
    datos.total,
    datos.fechaEmision,
    nombreArchivoSeguro,
    buffer,
    "application/pdf",
    message.id,
    adjunto.body.attachmentId,
  ]
);

          const [verificar] = await db.query(
            "SELECT LENGTH(pdf_data) AS bytes_pdf FROM documentos WHERE id = ?",
            [result.insertId]
          );

          console.log("✅ PDF nuevo procesado:", adjunto.filename);
          console.log("✅ Insertado ID:", result.insertId);
          console.log("✅ Bytes en BD:", verificar[0].bytes_pdf);

          procesados++;
        }
      } catch (error) {
        console.error("❌ Error procesando adjunto:", adjunto.filename, error.message);
        errores++;
      }
    }
  }

  return {
    ok: true,
    correos_encontrados: mensajes.length,
    pdfs_procesados: procesados,
    omitidos,
    errores,
  };
}

async function sincronizarGmailNuevo() {
  return await sincronizarGmailBase("has:attachment newer_than:10m", false);
}

async function sincronizarGmailHistorico() {
  return await sincronizarGmailBase("has:attachment", true);
}

app.get("/sync-gmail", async (req, res) => {
  try {
    const resultado = await sincronizarGmailNuevo();
    res.json(resultado);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/sync-gmail-historico", async (req, res) => {
  try {
    const resultado = await sincronizarGmailHistorico();
    res.json(resultado);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/documentos", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
        id,
        tipo_documento,
        serie,
        correlativo,
        numero,
        ruc,
        ruc_emisor,
        ruc_cliente,
dni_cliente,
        monto,
        fecha_emision,
        archivo_pdf,
        archivos_xml AS archivo_xml,
        gmail_message_id,
        created_at,
        LENGTH(pdf_data) AS bytes_pdf,
        LENGTH(xml_data) AS bytes_xml
      FROM documentos
      ORDER BY id DESC`
    );

    res.json(rows);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/documentos/:id/pdf", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT archivo_pdf, pdf_data, pdf_mime
       FROM documentos
       WHERE id = ?`,
      [req.params.id]
    );

    if (!rows.length || !rows[0].pdf_data) {
      return res.status(404).send("PDF no encontrado");
    }

    const pdfBuffer = Buffer.isBuffer(rows[0].pdf_data)
      ? rows[0].pdf_data
      : Buffer.from(rows[0].pdf_data.data);

    res.setHeader("Content-Type", rows[0].pdf_mime || "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${rows[0].archivo_pdf || "documento.pdf"}"`
    );
    res.setHeader("Content-Length", pdfBuffer.length);

    res.end(pdfBuffer);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error mostrando PDF");
  }
});

app.get("/documentos/:id/descargar", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT archivo_pdf, pdf_data, pdf_mime
       FROM documentos
       WHERE id = ?`,
      [req.params.id]
    );

    if (!rows.length || !rows[0].pdf_data) {
      return res.status(404).send("PDF no encontrado");
    }

    const pdfBuffer = Buffer.isBuffer(rows[0].pdf_data)
      ? rows[0].pdf_data
      : Buffer.from(rows[0].pdf_data.data);

    res.setHeader("Content-Type", rows[0].pdf_mime || "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${rows[0].archivo_pdf || "documento.pdf"}"`
    );
    res.setHeader("Content-Length", pdfBuffer.length);

    res.end(pdfBuffer);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error descargando PDF");
  }
});

app.get("/documentos/:id/xml", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT archivos_xml, xml_data, xml_mime
       FROM documentos
       WHERE id = ?`,
      [req.params.id]
    );

    if (!rows.length || !rows[0].xml_data) {
      return res.status(404).send("XML no encontrado");
    }

    const xmlBuffer = Buffer.isBuffer(rows[0].xml_data)
      ? rows[0].xml_data
      : Buffer.from(rows[0].xml_data.data);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${rows[0].archivos_xml || "documento.xml"}"`
    );
    res.setHeader("Content-Length", xmlBuffer.length);

    res.end(xmlBuffer);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error descargando XML");
  }
});

app.use("/pdfs", express.static(PDF_DIR));

function extraerDatosClienteXml(buffer) {
  const xml = buffer.toString("utf8");

  const customerBlock =
    xml.match(/<cac:AccountingCustomerParty[\s\S]*?<\/cac:AccountingCustomerParty>/i)?.[0] || "";

  const idMatch =
    customerBlock.match(/<cbc:ID[^>]*schemeID="([^"]+)"[^>]*>(\d{8,11})<\/cbc:ID>/i) ||
    customerBlock.match(/<cbc:ID[^>]*>(\d{8,11})<\/cbc:ID>/i);

  let rucCliente = null;
  let dniCliente = null;

  if (idMatch) {
    const scheme = idMatch.length === 3 ? idMatch[1] : null;
    const numero = idMatch.length === 3 ? idMatch[2] : idMatch[1];

    if (scheme === "6" || numero.length === 11) {
      rucCliente = numero;
    }

    if (scheme === "1" || numero.length === 8) {
      dniCliente = numero;
    }
  }

  return {
    rucCliente,
    dniCliente,
  };
}

const API_KEY = "ZR_MEDIC_2026";

function validarApiKey(req, res, next) {
  const apiKey =
    req.headers["x-api-key"] ||
    req.query.api_key;

  if (apiKey !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "API Key inválida",
    });
  }

  next();
}
app.get("/api/documentos", validarApiKey, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
        id,
        tipo_documento,
        serie,
        correlativo,
        numero,
        ruc_emisor,
        ruc_cliente,
        dni_cliente,
        monto,
        fecha_emision,
        archivo_pdf,
        archivos_xml AS archivo_xml,
        created_at
      FROM documentos
      ORDER BY id DESC`
    );

    res.json({
      ok: true,
      total: rows.length,
      data: rows,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/api/documentos/cliente/:documento", validarApiKey, async (req, res) => {
  try {
    const documento = req.params.documento;

    const [rows] = await db.query(
      `SELECT
        id,
        tipo_documento,
        serie,
        correlativo,
        numero,
        ruc_emisor,
        ruc_cliente,
        dni_cliente,
        monto,
        fecha_emision,
        archivo_pdf,
        archivos_xml AS archivo_xml,
        created_at
      FROM documentos
      WHERE ruc_cliente = ?
      OR dni_cliente = ?
      ORDER BY fecha_emision DESC`,
      [documento, documento]
    );

    res.json({
      ok: true,
      total: rows.length,
      data: rows,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

async function iniciarServidor() {
  try {
    await conectarMySQL();

    app.listen(PORT, async () => {
      console.log(`Servidor iniciado en puerto ${PORT}`);
      console.log(`http://localhost:${PORT}`);

      console.log("🚀 Sincronización histórica inicial...");
      try {
        const resultadoInicial = await sincronizarGmailHistorico();

        console.log(
          `✅ Histórico inicial: ${resultadoInicial.pdfs_procesados} nuevos | ${resultadoInicial.omitidos} omitidos`
        );
      } catch (error) {
        console.error("❌ Error en histórico inicial:", error.message);
      }

      setInterval(async () => {
        try {
          console.log("⏳ Revisando correos nuevos últimos 10 minutos...");

          const resultado = await sincronizarGmailNuevo();

          console.log(
            `✅ Auto-sync: ${resultado.pdfs_procesados} nuevos | ${resultado.omitidos} omitidos`
          );
        } catch (error) {
          console.error("❌ Error automático:", error.message);
        }
      }, 5 * 60 * 1000);
    });
  } catch (error) {
    console.error("Error iniciando servidor:", error.message);
  }
}

iniciarServidor();

 