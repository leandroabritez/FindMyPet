import pandas as pd
from datetime import date
from datetime import timedelta
import pyodbc
import seaborn as sns
import matplotlib.pyplot as plt
from sqlalchemy import create_engine
import urllib
import os
import win32com.client as win32
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
import tempfile

params = urllib.parse.quote_plus(
    "DRIVER={ODBC Driver 17 for SQL Server};"
    "SERVER=172.22.1.29;"
    "DATABASE=BI_DATA_WAREHOUSE;"
    "UID=RS_BI_DB;"
    "PWD=qBadKQG5mfkb"
)

engine = create_engine(f"mssql+pyodbc:///?odbc_connect={params}")

# Query para obtener los datos de NPS
query = """
SELECT 
    s.[fecha_envio],
    s.[id_empresa],
    e.EMPRESA,
    s.[id_negocio],
    n.negocio,
    CASE 
        WHEN n.id_negocio = 1 AND d.sede = 'Bessone'			THEN 'HOSPITALES_Bessone'
        WHEN n.id_negocio = 1									THEN 'HOSPITALES_Clinica'
		WHEN n.id_negocio = 2 AND d.sede = 'DOMICILIO'			THEN 'B2C_Domicilio'
		WHEN n.id_negocio = 2 AND d.sede = 'DOMICILIOSLM(49)'	THEN 'B2C_Domicilio'
        ELSE n.negocio
    END AS negocio_final,
    COUNT(d.id_registro) AS cantidad
FROM BI_DATA_WAREHOUSE.dbo.NPS_SEGMENTO s
LEFT JOIN BI_DATA_WAREHOUSE.dbo.NPS_SEGMENTO_DETALLE d ON s.id_segmento = d.id_segmento
LEFT JOIN BI_DATA_WAREHOUSE.dbo.EMPRESA_DW e ON s.id_empresa = e.EMPRESA_ID_DW
LEFT JOIN BI_DATA_WAREHOUSE.dbo.NEGOCIO n ON n.id_negocio = s.id_negocio
--WHERE s.id_empresa = 3 AND s.id_negocio = 4
GROUP BY 
    s.fecha_envio,
    s.id_empresa,
    e.EMPRESA,
    s.id_negocio,
    n.negocio,
    CASE 
        WHEN n.id_negocio = 1 AND d.sede = 'Bessone'			THEN 'HOSPITALES_Bessone'
        WHEN n.id_negocio = 1									THEN 'HOSPITALES_Clinica'
		WHEN n.id_negocio = 2 AND d.sede = 'DOMICILIO'			THEN 'B2C_Domicilio'
		WHEN n.id_negocio = 2 AND d.sede = 'DOMICILIOSLM(49)'	THEN 'B2C_Domicilio'
        ELSE n.negocio
     END
"""

df = pd.read_sql(query, engine)

# Asegurar tipos correctos
df['fecha_envio'] = pd.to_datetime(df['fecha_envio'])

# Crear columna con día de la semana (lunes=0, domingo=6)
df['dia_semana'] = df['fecha_envio'].dt.dayofweek

# Separar envíos de hoy
hoy = pd.to_datetime(date.today())
dia_hoy = hoy.dayofweek
df_hoy = df[df['fecha_envio'] == hoy]

#  Calcular mediana por empresa, negocio_final y día de la semana
medianas = (
    df
    .groupby(['id_empresa','EMPRESA' ,'negocio_final', 'dia_semana'])['cantidad']
    .median()
    .reset_index()
    .rename(columns={'cantidad': 'mediana'})
)

# Merge con los envíos de hoy
df_hoy = df_hoy.copy()      # Evitar SettingWithCopyWarning   



#  Generar todas las combinaciones posibles esperadas hoy
combinaciones_esperadas = medianas[medianas['dia_semana'] == dia_hoy][['id_empresa', 'negocio_final', 'dia_semana']].drop_duplicates()

#  Merge con los envíos de hoy (incluyendo los que no tienen registros hoy → cantidad será NaN)
df_hoy_completo = pd.merge(
    combinaciones_esperadas,
    df_hoy[['id_empresa', 'negocio_final', 'dia_semana', 'cantidad']],
    on=['id_empresa', 'negocio_final', 'dia_semana'],
    how='left'
)

# Traer las medianas
df_check = pd.merge(df_hoy_completo, medianas, on=['id_empresa', 'negocio_final', 'dia_semana'], how='left')

# Reemplazar NaN en cantidad por 0 (casos sin registros hoy)
df_check['cantidad'] = df_check['cantidad'].fillna(0)

#  Detectar alertas
df_check['alerta'] = df_check['cantidad'] < (df_check['mediana'] * 0.7)

#  Filtrar alertas
alertas = df_check[df_check['alerta']]


#  Días en español
dias_es = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
medianas['nombre_dia'] = medianas['dia_semana'].apply(lambda x: dias_es[x])

#  Crear columna combinada sin guiones sobrantes
medianas['empresa_negocio'] = (
    medianas['EMPRESA'].fillna('').str.strip() + 
    ' - ' + 
    medianas['negocio_final'].fillna('').str.strip()
)
medianas['empresa_negocio'] = medianas['empresa_negocio'].str.rstrip(' -').str.strip()

#  Pivot ordenado por día (usamos Categorical)
medianas['nombre_dia'] = pd.Categorical(
    medianas['nombre_dia'],
    categories=dias_es,
    ordered=True
)

tabla_heatmap = medianas.pivot_table(
    index='empresa_negocio',
    columns='nombre_dia',
    values='mediana',
    fill_value=0,
    observed=False  # 👈 esto evita el warning
)

#  Mapa de calor
fig1, ax1 = plt.subplots(figsize=(12, 8))
sns.heatmap(tabla_heatmap, annot=True, fmt=".0f", cmap="YlOrRd", cbar_kws={'label': 'Mediana de envíos'})
plt.title("Mapa de calor: Mediana de envíos por día")
plt.xlabel("Día de la semana")
plt.ylabel("Empresa - Negocio")
plt.tight_layout()

# Crear carpeta temporal
temp_dir = tempfile.gettempdir()

# Ruta temporal para fig1
ruta_fig1 = os.path.join(temp_dir, "grafico_heatmap_mediana.png")
fig1.savefig(ruta_fig1, dpi=300, bbox_inches='tight')
plt.close(fig1)


# ARMAR SEGMENTO ULTIMA SEMANA

inicio_7d = hoy - timedelta(days=6)  # incluye hoy
df_ultimos_7d = df[df['fecha_envio'].between(inicio_7d, hoy)].copy()
df_ultimos_7d['nombre_dia'] = df_ultimos_7d['fecha_envio'].dt.dayofweek.apply(lambda x: dias_es[x])

#  AGREGO MEDIANAS 
df_7d_check = pd.merge(
    df_ultimos_7d,
    medianas[['id_empresa', 'negocio_final', 'dia_semana', 'mediana']],
    on=['id_empresa', 'negocio_final', 'dia_semana'],
    how='left'
)

#  DEFINICIÓN CRITERIOS DE COLOR

def clasificar_alerta(row):
    if row['cantidad'] >= row['mediana'] * 0.7:
        return 'verde'
    elif row['cantidad'] >= row['mediana'] * 0.5:
        return 'amarillo'
    else:
        return 'rojo'

df_7d_check['nivel_alerta'] = df_7d_check.apply(clasificar_alerta, axis=1)

# ### CONFIGURACIÓN DE VARIABLES PARA MAPA
# 
# - Creo variable Empresa + Negocio
# - Armo tabla pivot con cantidad
# - Armo tabla pivot con color
# - Ordeno por fecha

# Crear etiqueta combinada
df_7d_check['empresa_negocio'] = (
    df_7d_check['EMPRESA'].fillna('').str.strip() + ' - ' + df_7d_check['negocio_final'].fillna('').str.strip()
).str.rstrip(' -')

df_7d_check['fecha_formato'] = df_7d_check['fecha_envio'].dt.strftime('%d/%m')

# Cantidades
tabla_cantidades = df_7d_check.pivot_table(
    index='empresa_negocio',
    columns='fecha_formato',
    values='cantidad',
    aggfunc='sum',
    fill_value=0
)

# Colores
tabla_colores = df_7d_check.pivot_table(
    index='empresa_negocio',
    columns='fecha_formato',
    values='nivel_alerta',
    aggfunc='first',
    fill_value='rojo'
)

# Lista de fechas ordenadas (últimos 7 días)
fechas_ordenadas = pd.date_range(start=inicio_7d, end=hoy).strftime('%d/%m').tolist()

# Reordenar columnas de ambas tablas
tabla_cantidades = tabla_cantidades[fechas_ordenadas]
tabla_colores = tabla_colores[fechas_ordenadas]

# ### DEFINO COLRORES Y PASO A RGB

# Crear un mapa de colores
color_map = {'verde': '#4CAF50', 'amarillo': '#FFEB3B', 'rojo': '#F44336'}

# Convertir valores de alerta a colores hex
tabla_colores_rgb = tabla_colores.apply(lambda col: col.map(lambda x: color_map.get(x, '#FFFFFF')))

# ### MAPA DE COLOR CON CANTIDAD Y LUEGO ASIGNO COLOR EN EL MISMO ORDEN

fig2, ax2 = plt.subplots(figsize=(12, 8))

# Graficar un heatmap dummy (sin colores reales, solo para el layout)
sns.heatmap(
    tabla_cantidades, 
    cmap="Greys", 
    cbar=False, 
    annot=tabla_cantidades, 
    fmt=".0f", 
    linewidths=0.5,
    linecolor='grey',
    xticklabels=tabla_cantidades.columns,
    yticklabels=tabla_cantidades.index,
    mask=False,
    annot_kws={'color': 'black'},
    ax=ax2
)

# Colorear manualmente los fondos
for y in range(tabla_colores_rgb.shape[0]):
    for x in range(tabla_colores_rgb.shape[1]):
        ax2.add_patch(plt.Rectangle(
            (x, y), 1, 1, fill=True,
            color=tabla_colores_rgb.iat[y, x],
            ec='grey', lw=0.5
        ))

# Títulos y ajustes
plt.title("Últimos 7 días - Tasa de envío", fontsize=14)
plt.xlabel("Día")
plt.ylabel("Empresa - Negocio")
plt.xticks(rotation=45)
plt.tight_layout()

# Ruta temporal para fig2
ruta_fig2 = os.path.join(temp_dir, "grafico_heatmap_semana.png")
fig2.savefig(ruta_fig2, dpi=300, bbox_inches='tight')
plt.close(fig2)

# ### MAILING

if not alertas.empty:

    # 1. Convertir df_alertas a tabla HTML
    html_table = alertas.to_html(index=False)

    # 2. Crear contenido del mail
    asunto = "🚨 Alerta de envíos NPS - Diario"
    cuerpo_html = f"""
    <html>
    <head></head>
    <body>
    <p>Hola,</p>

    <p>Estos son los segmentos diarios con <b>alertas NPS</b> detectadas hoy:</p>

    {html_table}

    <p>Adjunto también el gráfico de tasa semanal y medianas históricas por negocio.</p>

    <p>Saludos,<br>Tu sistema automático 😊</p>
    </body>
    </html>
    """

    # 3. Configuración SMTP
    smtp_server = "172.16.1.7"
    smtp_port = 25
    from_addr = "noreply@diagnosticomaipu.com.ar"
    to_addrs = ["leandro.britez@qservices.com.ar","lacosta.ext@diagnosticomaipu.com.ar"]

    # 4. Crear mensaje
    msg = MIMEMultipart()
    msg['From'] = from_addr
    msg['To'] = ", ".join(to_addrs)
    msg['Subject'] = asunto
    msg.attach(MIMEText(cuerpo_html, 'html'))

    # 5. Adjuntar gráficos
    for archivo in [ruta_fig1, ruta_fig2]:
        ruta = os.path.abspath(archivo)
        with open(ruta, "rb") as f:
            adjunto = MIMEApplication(f.read(), Name=os.path.basename(archivo))
            adjunto['Content-Disposition'] = f'attachment; filename="{os.path.basename(archivo)}"'
            msg.attach(adjunto)

    # 6. Enviar mail
    with smtplib.SMTP(smtp_server, smtp_port) as server:
        server.sendmail(from_addr, to_addrs, msg.as_string())

    print("✅ Correo enviado exitosamente por SMTP.")

    # 7. Eliminar archivos temporales
    os.remove(ruta_fig1)
    os.remove(ruta_fig2)

else:
    print("📭 No se enviaron alertas hoy: el DataFrame 'alertas' está vacío.")
