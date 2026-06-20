# -*- coding: utf-8 -*-
"""
verificar_downloads_http.py

Verifica, para TODOS os municípios listados em municipios.json, se os
ficheiros de download (CAOP, COS, BGRI, MDT e camadas OSM) estão
acessíveis via HTTP no teu servidor local (ex: http://localhost:8000/).

Uso (no Spyder ou terminal):
    1. Garante que o teu servidor local está a correr
       (ex: python -m http.server 8000 dentro da pasta do site).
    2. Ajusta BASE_URL abaixo, se necessário.
    3. Corre o script.
    4. No final é gerado um relatório no ecrã e um ficheiro
       "relatorio_ficheiros_em_falta2.csv" com todos os ficheiros em falta.

Requer a biblioteca 'requests' (pip install requests --break-system-packages,
se ainda não a tiveres).
"""

import json
import csv
import requests
from urllib.parse import quote

# ────────────────────────────────────────────────────────────────────────
# CONFIGURAÇÃO
# ────────────────────────────────────────────────────────────────────────

BASE_URL = "http://localhost:8000/"   # <-- ajusta se necessário (com / no fim)
MUNICIPIOS_JSON_URL = BASE_URL + "data/municipios.json"  # ajusta se estiver noutro sítio

OUTPUT_CSV = "C:/Users/jdsm3/Desktop/relatorio_ficheiros_em_falta2.csv"
TIMEOUT = 5  # segundos por pedido


def slug(texto: str) -> str:
    return texto.replace(" ", "_")


def url_existe(url: str) -> tuple[bool, str]:
    """
    Testa se um URL responde com sucesso.
    Faz HEAD primeiro (mais rápido); se o servidor não suportar bem HEAD
    (alguns http.server simples respondem mal), tenta GET em stream.
    """
    try:
        r = requests.head(url, timeout=TIMEOUT, allow_redirects=True)
        if r.status_code == 200:
            return True, "OK"
        if r.status_code == 405:  # método não permitido -> tenta GET
            r = requests.get(url, timeout=TIMEOUT, stream=True)
            r.close()
            if r.status_code == 200:
                return True, "OK"
            return False, f"HTTP {r.status_code}"
        return False, f"HTTP {r.status_code}"
    except requests.exceptions.ConnectionError:
        return False, "Erro de ligação (servidor local está a correr?)"
    except requests.exceptions.Timeout:
        return False, "Timeout"
    except Exception as e:
        return False, f"Erro: {e}"


def montar_url(rel_path: str) -> str:
    # Codifica cada segmento do path (mantém as barras), preserva acentos como %xx
    partes = rel_path.split("/")
    partes_codificadas = [quote(p) for p in partes]
    return BASE_URL + "/".join(partes_codificadas)


def verificar():
    print(f"🔎 A obter lista de municípios de: {MUNICIPIOS_JSON_URL}")
    try:
        resp = requests.get(MUNICIPIOS_JSON_URL, timeout=TIMEOUT)
        resp.raise_for_status()
        municipios = resp.json()
    except Exception as e:
        print(f"❌ Não consegui obter municipios.json: {e}")
        print("   Confirma o BASE_URL e o caminho de MUNICIPIOS_JSON_URL.")
        return

    print(f"✅ {len(municipios)} municípios carregados. A verificar ficheiros...\n")

    em_falta = []
    total_verificados = 0

    for m in municipios:
        municipio = m.get("municipio", "")
        distrito = m.get("distrito", "")
        distrito_slug = slug(distrito)
        municipio_slug = slug(municipio)

        # ── 1) Ficheiros diretos (caop, cos, bgri, mdt) ──
        campos_diretos = {
            "CAOP": "caop_zip",
            "COS": "cos_zip",
            "BGRI": "bgri_zip",
            "MDT": "mdt_zip",
        }

        for nome_tipo, campo in campos_diretos.items():
            rel_path = m.get(campo)
            total_verificados += 1
            if not rel_path:
                em_falta.append({
                    "municipio": municipio, "distrito": distrito, "tipo": nome_tipo,
                    "caminho_relativo": "(campo ausente no JSON)",
                    "url": "-", "motivo": "Campo não definido no municipios.json"
                })
                continue

            url = montar_url(rel_path)
            ok, motivo = url_existe(url)
            if not ok:
                em_falta.append({
                    "municipio": municipio, "distrito": distrito, "tipo": nome_tipo,
                    "caminho_relativo": rel_path, "url": url, "motivo": motivo
                })

        # ── 2) Camadas OSM ──
        camadas = m.get("selected_layers", [])
        for layer in camadas:
            total_verificados += 1
            rel_path = f"data/{distrito_slug}/{municipio_slug}/OSM_{layer}_{municipio_slug}.zip"
            url = montar_url(rel_path)
            ok, motivo = url_existe(url)
            if not ok:
                em_falta.append({
                    "municipio": municipio, "distrito": distrito, "tipo": f"OSM:{layer}",
                    "caminho_relativo": rel_path, "url": url, "motivo": motivo
                })

        print(f"  ...{municipio} verificado")

    # ── Relatório ──
    print(f"\n✅ Verificação concluída: {total_verificados} ficheiros verificados.")
    print(f"⚠️  {len(em_falta)} ficheiros em falta ou com problemas.\n")

    if em_falta:
        municipios_afetados = {}
        for item in em_falta:
            municipios_afetados.setdefault(item["municipio"], []).append(item)

        for municipio, items in municipios_afetados.items():
            print(f"📍 {municipio} ({items[0]['distrito']}):")
            for it in items:
                print(f"   - [{it['tipo']}] {it['caminho_relativo']}  → {it['motivo']}")
            print()

        with open(OUTPUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=["municipio", "distrito", "tipo", "caminho_relativo", "url", "motivo"])
            writer.writeheader()
            writer.writerows(em_falta)
        print(f"📄 Relatório completo gravado em: {OUTPUT_CSV}")
    else:
        print("🎉 Todos os ficheiros estão acessíveis!")


if __name__ == "__main__":
    verificar()