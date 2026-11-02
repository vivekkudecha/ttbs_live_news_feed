"""
TTBS Company Signal Research Script
------------------------------------
Requirements:
    pip install requests python-dotenv

Environment variable:
    PERPLEXITY_API_KEY=your_perplexity_api_key

Usage:
    python ttbs_research.py
"""

import os
import re
import csv
import json, time
import random
import threading
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

import requests


API_KEY = os.getenv("PERPLEXITY_API_KEY")
if not API_KEY:
    raise SystemExit("Set PERPLEXITY_API_KEY in your environment or .env file.")

API_URL = "https://api.perplexity.ai/v1/agent"
PRESET = "high"  # Use "fast" for quicker, lighter research runs

# Perplexity allows 50 requests/second; stay a little under to leave headroom
MAX_REQUESTS_PER_SECOND = 45
MAX_RETRIES = 5


class RateLimiter:
    """Thread-safe sliding-window limiter: at most `max_calls` per `period` seconds."""

    def __init__(self, max_calls: int, period: float = 1.0):
        self.max_calls = max_calls
        self.period = period
        self.calls = deque()
        self.lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self.lock:
                now = time.monotonic()
                while self.calls and now - self.calls[0] >= self.period:
                    self.calls.popleft()
                if len(self.calls) < self.max_calls:
                    self.calls.append(now)
                    return
                wait = self.period - (now - self.calls[0])
            time.sleep(wait)


rate_limiter = RateLimiter(MAX_REQUESTS_PER_SECOND)


def post_with_retry(payload: dict) -> requests.Response:
    """POST to the Perplexity API under the rate limit, retrying 429/5xx with backoff."""
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    for attempt in range(MAX_RETRIES + 1):
        rate_limiter.acquire()
        try:
            response = requests.post(API_URL, headers=headers, json=payload, timeout=300)
        except (requests.ConnectionError, requests.Timeout):
            if attempt == MAX_RETRIES:
                raise
        else:
            if response.status_code != 429 and response.status_code < 500:
                return response
            if attempt == MAX_RETRIES:
                return response
            retry_after = response.headers.get("Retry-After")
            if retry_after and retry_after.replace(".", "", 1).isdigit():
                time.sleep(float(retry_after))
                continue
        # Exponential backoff with jitter so threads don't retry in lockstep
        time.sleep(min(2 ** attempt, 30) + random.uniform(0, 1))

# COMPANIES = [
#     "Thriveni Earthmovers and Infra Private Limited",
#     "Regaal Resources Limited",
#     "Perfectus Technology Solutions Private Limited",
#     "mPokket Financial Services Private Limited",
#     "Lloyds Metals and Energy Ltd",
#     "Logile India Private Limited",
#     "Calcutta Television Network Private Limited",
#     "Eastern Media Limited",
#     "Pratham Broadcast India Private Limited",
#     "Century Plyboards India Ltd",
#     "DAWNSUN KYOSEI ENGINEERING PRIVATE LIMITED",
#     "DBG TECHNOLOGY INDIA PRIVATE LIMITED",
#     "DCM SHRIRAM INDUSTRIES LTD",
#     "DEFSYS SOLUTIONS PRIVATE LIMITED",
#     "DEL CAP DRAGON INDIA PRIVATE LIMITED",
#     "DELDIA INDUSTRIES PRIVATE LIMITED",
#     "ADVANTAGE CLUB TECHNOLOGIES PRIVATE LIMITED",
#         "AUTHBRIDGE RESEARCH SERVICES PRIVATE LIMITED",
#         "BUSCH GROUP IT INDIA PRIVATE LIMITED",
#         "BLACKBOARD E LEARNING PRIVATE LIMITED",
#         "COOLBOOTS MEDIA PRIVATE LIMITED",
#         "CSL FINANCE LIMITED",
#         "DFM FOODS LIMITED",
#         "EDUNET FOUNDATION",
#         "ETERNAL LIMITED",
#         "HELLO VERIFY INDIA PRIVATE LIMITED",
#         "NAT IT SERVICES PRIVATE LIMITED",
#         "PAYU PAYMENTS PRIVATE LIMITED",
#         "PROMOTION VALA",
#         "TBO TEK LIMITED",
#         "TRUWORX SPACES PRIVATE LIMITED",
#         "WHEELSEYE TECHNOLOGY INDIA PRIVATE LIMITED",
#         "ZOMATO HYPERPURE PRIVATE LIMITED",
#         "ZUARI FINSERV LIMITED",

#     "AIRTEL INTERNATIONAL LLP",
#     "SYRMA JOHARI MEDTECH LIMITED",
#     "FNP E RETAIL PRIVATE LIMITED",
#     "SMC INSURANCE BROKERS PVT LTD",
#     "PAYU DIGITAL LABS PRIVATE LIMITED",
#     "PEGEEN BUILDERS & DEVELOPERS PRIVATE LIMITED",
#     "ACTION CONSTRUCTION EQUIPMENT LIMITED",
#     "FRESENIUS MEDICAL CARE INDIA PRIVATE LIMITED",
#     "REDCLIFFE HYGIENE PRIVATE LIMITED",
#     "YOKOHAMA INDIA PRIVATE LIMITED",
#     "PARVIOM TECHNOLOGIES PRIVATE LIMITED",
#     "MIRAGGIO LIFESTYLES PRIVATE LIMITED",
#     "DMI FINANCE PRIVATE LIMITED",
#     "D.PAULS TRAVEL AND TOURS LIMITED",
#     "RADIATE E-SERVICES PRIVATE LIMITED",
#     "PRUDENT INSURANCE BROKERS PRIVATE LIMITED",
#     "MAX ASSET SERVICES LIMITED",
#     "SHUBHAM HOUSING DEVELOPMENT FINANCE COMPANY LIMITED",
#     "OMRON AUTOMATION PRIVATE LIMITED",
#     "VERTIV ENERGY PVT LTD",
#     "APTARA LEARNING PRIVATE LIMITED",
#     "IKM INVESTORS PRIVATE LIMITED",
#     "NOPAPERFORMS SOLUTIONS LIMITED",
#     "TEMPORA MUTANTUR PRIVATE LIMITED",
#     "CONTINENTAL INDIA PRIVATE LIMITED",
#     "MAYBRIGHT VENTURES PRIVATE LIMITED",
#     "BRY- AIR ASIA PRIVATE LIMITED",
#     "INNOVA AM TECH PRIVATE LIMITED",
#     "OCUBE SERVICES PRIVATE LIMITED",
#     "SG FINSERVE LIMITED",
#     "SEMTECH ADVANCED SYSTEMS INDIA PRIVATE LIMITED",
#     "POINT TO POINT CONSULTANTS LLP",
#     "VINFAST AUTO INDIA PRIVATE LIMITED",
#     "SUNBEAM LIGHTWEIGHTING SOLUTIONS PRIVATE LIMITED",
#     "JIVA AYURVEDIC PHARMACY LIMITED",
#     "TOYOTA FINANCIAL SERVICES INDIA LIMITED",
#     "GEODIS INDIA PRIVATE LIMITED",
#     "MPS LTD",
#     "SMARTWORLD DEVELOPERS PRIVATE LIMITED",
#     "NETWAY INDIA PRIVATE LIMITED",
#     "ROSMERTA TECHNOLOGIES LIMITED",
#     "FLUID3 INFOTECH PRIVATE LIMITED",
#     "TURBOML PRIVATE LIMITED",
#     "CAPITAL INDIA FINANCE LIMITED",
#     "ATC INFOCOM SOLUTIONS",
#     "SOLUTIONS OFFSHOOT",
#     "MIDEA INDIA PRIVATE LIMITED",
#     "GC WEB VENTURES PRIVATE LIMITED",
#     "C2FO FACTORING SOLUTIONS PRIVATE LIMITED",
# ]

COMPANIES = [
    "108 EMERGENCY MEDICAL TRANSPORT SERVICES EAST UP",
    "23 WATTS MEDIA PRIVATE LIMITED",
    "360 REALTORS LLP",
    "3I INFOTECH LTD",
    "4SIGHT SOLUTIONS PRIVATE LIMITED",
    "AAVERINA HOSPITALITY PRIVATE LIMITED",
    "ACAASA MANAGEMENT SERVICES PRIVATE LIMITED",
    "ACCOR ADVANTAGE PLUS MARKETING INDIA PRIVATE LIMITED",
    "ACEFONE SOFTWARE PRIVATE LIMITED",
    "ACEVECTOR LIMITED",
    "ACIDAES SOLUTIONS PVT LTD",
    "ACROSS ASSIST PRIVATE LIMITED",
    "ACTION CONSTRUCTION EQUIPMENT LIMITED",
    "ADGLOBAL360 INDIA PRIVATE LIMITED",
    "ADITYA INFOTECH LTD",
    "ADVANTAGE CLUB TECHNOLOGIES PRIVATE LIMITED",
    "AECC INDIA PRIVATE LIMITED",
    "AECOM ASIA COMPANY LIMITED",
    "AECOM INDIA PRIVATE LIMITED",
    "AFFORDABLE INFRASTRUCTURE AND HOUSING PROJECTS PVT LTD",
    "AFTERSHOOT PRIVATE LIMITED",
    "AGARWAL PACKERS AND MOVERS LIMITED",
    "AGASTYA ENERGY INDUSTRIES PRIVATE LIMITED",
    "AGRO VILLAGE",
    "AIMIL HEALTHCARE AND RESEARCH CENTRE",
    "AIMIL LIMITED",
    "AIMIL PHARMACEUTICALSINDIA LIMITED",
    "AIRTEL INTERNATIONAL LLP",
    "AIVS PINCODEKART PRIVATE LIMITED",
    "AKS INFORMATION TECHNOLOGY SERVICES PRIVATE LIMITED",
    "ALKAMI TECHNOLOGY INDIA PRIVATE LIMITED",
    "ALLIANZ PARTNERS GLOBAL BUSINESS SOLUTIONS PVT LTD",
    "AMBUJA NEOTIA HEALTHCARE VENTURE LIMITED",
    "AMPLIFON (INDIA) PRIVATE LIMITED",
    "ANAND NVH PRODUCTS PRIVATE LIMITED",
    "ANANDA DAIRY LTD",
    "ANKURA CONSULTING INDIA PRIVATE LIMITED",
    "ANOLYTICS",
    "APEEJAY STYA EDUCATION FOUNDATION",
    "APPINVENTIV TECHNOLOGIES PRIVATE LIMITED",
    "APPTAD TECHNOLOGIES PRIVATE LIMITED",
    "APTARA LEARNING PRIVATE LIMITED",
    "ARCIS E SERVICES PRIVATE LIMITED",
    "ARISTO SECURITIES PRIVATE LIMITED",
    "ART HOUSING FINANCE INDIA LIMITED",
    "ARTEMIS MEDICARE SERVICES LTD",
    "ARYA BRAND LABS",
    "ASA CORPORATE CATALYST INDIA PRIVATE LIMITED",
    "ASARFI HOSPITAL LIMITED",
    "Asian Christian Academy of India",
    "ASIAN FILMS TV PRIVATE LIMITED",
    "ASSOCIATION OF MANAGEMENTSTUDIES",
    "ASTEMO INDIA PRIVATE LIMITED",
    "ASTRO ARUN PANDIT PRIVATE LIMITED",
    "ATC INFOCOM SOLUTIONS",
    "ATTERO RECYCLING PRIVATE LIMITED",
    "AUMENTO RESEARCH PRIVATE LIMITED",
    "AUTHBRIDGE RESEARCH SERVICES PRIVATE LIMITED",
    "AVAADA CLEAN PROJECT PRIVATE LIMITED",
    "AVAADA ENERGY PRIVATE LIMITED",
    "AVIS ESOLUTIONS PRIVATE LIMITED",
    "AWC SOFTWARE PRIVATE LIMITED",
    "B N AGRITECH LTD",
    "B N CORPORATE PARK PRIVATE LIMITED",
    "BALAJEE EDUCATION PRIVATE LIMITED",
    "BANDHAN BANK LIMITED",
    "BANGALORE HOSPICE TRUST",
    "BANKIT SERVICES PRIVATE LIMITED",
    "BEAM GLOBAL SPIRITS AND WINE INDIA PRIVATE LIMITED",
    "BELDEN INDIA PRIVATE LIMITED",
    "BENNETT UNIVERSITY",
    "BENO SUPPORT TECHNOLOGIES PRIVATE LIMITED",
    "BERSHKA RETAIL INDIA PRIVATE LIMITED",
    "BEUMER INDIA PRIVATE LIMITED",
    "BHARATIYA JANATA PARTY",
    "BHUSHAN POWER AND STEEL LIMITED",
    "BIBA FASHION LIMITED",
    "BIG BOY TOYZ LIMITED",
    "BIKANERVALA FOODS PRIVATE LIMITED",
    "BIRDHILL CORPORATE SOLUTIONS PRIVATE LIMITED",
    "BLACK BOX LTD",
    "BLACKBOARD E LEARNING PRIVATE LIMITED",
    "BLACKROCK SERVICES INDIA PRIVATE LIMITED",
    "B-MAP FINTECH PRIVATE LIMITED",
    "BMW INDIA PRIVATE LIMITED",
    "BODYCARE INTERNATIONAL LIMITED",
    "BOKETTO TECHNOLOGIES PRIVATE LIMITED",
    "BPO CONVERGENCE PRIVATE LIMITED",
    "BRANCH INTERNATIONAL FINANCIAL SERVICES",
    "BRANCH INTERNATIONAL FINANCIAL SERVICES PRIVATE LIMITED",
    "BRANDMUSCLE INDIA PRIVATE LIMITED",
    "BREVISTAY HOSPITALITY PRIVATE LIMITED",
    "BRY- AIR ASIA PRIVATE LIMITED",
    "BTM VENTURES PRIVATE LIMITED",
    "BUREAU VERITAS CONSUMER PRODUCTS SERVICES INDIA PVT LTD",
    "BUSCH GROUP IT INDIA PRIVATE LIMITED",
    "BUSCH MANUFACTURING INDIA PRIVATE LIMITED",
    "BUSCH VACUUM INDIA PRIVATE LIMITED",
    "BUSY INFOTECH PVT LTD",
    "BYR INSURANCE BROKERS PRIVATE LIMITED",
    "C2FO FACTORING SOLUTIONS PRIVATE LIMITED",
    "CALIBEHR BUSINESS SUPPORT SERVICES PRIVATE LIMITED",
    "CAPITAL INDIA FINANCE LIMITED",
    "CARRUM MOBILITY SOLUTIONS PRIVATE LIMITED",
    "CARS24 FINANCIAL SERVICES PRIVATE LIMITED",
    "CARS24 SERVICES PRIVATE LIMITED",
    "CASIO INDIA CO PVT LTD",
    "CE SERVICED OFFICES PRIVATE LIMITED",
    "CHAT2FRIEND TECHNOLOGIES PRIVATE LIMITED",
    "CINEPOLIS INDIA PRIVATE LIMITED",
    "CIPHER RESEARCH PRIVATE LIMITED",
    "CK BIRLA HEALTHCARE PRIVATE LIMITED",
    "CLASSIC ENGINEERS",
    "CLIFFORD CHANCE BUSINESS SERVICES PRIVATE LIMITED",
    "COM VISION INDIA LIMITED",
    "COMMURE INDIA PRIVATE LIMITED",
    "COMPASS INDIA FOOD SERVICES PVT LTD",
    "COMPUTER POWER GROUP PRIVATE LIMITED",
    "CONNAUGHT PLAZA RESTAURANTS PVT LTD",
    "CONTAQUE CLOUD PRIVATE LIMITED",
    "CONTINENTAL INDIA PRIVATE LIMITED",
    "COOLBOOTS MEDIA PRIVATE LIMITED",
    "CORRZ TECHNOSOLUTIONS PRIVATE LIMITED",
    "CORRZ TELESERVICES PRIVATE LIMITED",
    "COS RETAIL PRIVATE LIMITED",
    "COZENTUS TECHNOLOGIES PRIVATE LIMITED",
    "CPP ASSISTANCE SERVICES PRIVATE LIMITED",
    "CR RAO ADV INST OF MATHEMATICS STATCSAND COMPUTERSCIENCE",
    "CREATIVE LIPI WEBTECH PRIVATE LIMITED",
    "CREDITAS SOLUTIONS PRIVATE LIMITED",
    "CSC E GOVERNANCE SERVICES INDIA LIMITED",
    "CSL FINANCE LIMITED",
    "CSM TECHNOLOGIES LIMITED",
    "CUBASTION CONSULTING PRIVATE LIMITED",
    "CUBE HIGHWAYS TECHNOLOGIES PRIVATE LIMITED",
    "CUBE SOFTWARE PRIVATE LIMITED",
    "CYLLID TECHNOLOGIES PRIVATE LIMITED",
    "D.PAULS TRAVEL AND TOURS LIMITED",
    "D2C INSURANCE BROKING PRIVATE LIMITED",
    "DASSAULT AIRCRAFT SERVICES INDIA PVT. LIMITED",
    "DAWNSUN KYOSEI ENGINEERING PRIVATE LIMITED",
    "DBG TECHNOLOGY INDIA PRIVATE LIMITED",
    "DCM SHRIRAM INDUSTRIES LTD",
    "DEFSYS SOLUTIONS PRIVATE LIMITED",
    "DEL CAP DRAGON INDIA PRIVATE LIMITED",
    "DELDIA INDUSTRIES PRIVATE LIMITED",
    "DENAVE INDIA PRIVATE LIMITED",
    "DENYO INDIA PRIVATE LIMITED",
    "DESKOTEL COMMUNICATIONS PRIVATE LIMITED",
    "DESKOTEL SOLUTIONS PRIVATE LIMITED",
    "DFM FOODS LIMITED",
    "DHAMPUR SUGAR MILLS LIMITED",
    "DIGITECH CALL SYSTEM PRIVATE LIMITED",
    "DIVERSE INFOTECH PRIVATE LIMITED",
    "DIVYA CAPITAL ONE PRIVATE LIMITED",
    "DMI ALTERNATIVES PRIVATE LIMITED",
    "DMI FINANCE PRIVATE LIMITED",
    "DMI HOUSING FINANCE PRIVATE LIMITED",
    "DT DETECTION TECHNOLOGY INDIA PRIVATE LIMITED",
    "DUA ASSOCIATES",
    "EASTERN MEDIA LIMITED",
    "EASTMAN CAST AND FORGE LTD",
    "EASWARI MEDIA PVT LTD",
    "EASY TRIP PLANNERS LIMITED",
    "ECHO INDIA MANAGED SERVICES PRIVATE LIMITED",
    "EDCIL INDIA LTD",
    "EDUNET FOUNDATION",
    "ELCON BANSHU WIRING SYSTEM PRIVATE LIMITED",
    "ELDERWISE SHOPPING INDIA PRIVATE LIMITED",
    "EMAAR INDIA LIMITED",
    "Entelect techsol LLP",
    "EPACK DURABLE LIMITED",
    "EQUILEND INDIA PRIVATE LIMITED",
    "E-SOLUTIONS IT SERVICES PRIVATE LIMITED",
    "ESPIRE INFOLABS PRIVATE LIMITED",
    "ESRI INDIA TECHNOLOGIES PRIVATE LIMITED",
    "ETERNAL LIMITED",
    "ETRADE MARKETING PRIVATE LIMITED",
    "EUI LIMITED",
    "EVERENVIRO RESOURCE MANAGEMENT PRIVATE LIMITED",
    "EXARCA CONSULTING PRIVATE LIMITED",
    "EXECUTIVE ACCESS INDIA PRIVATE LIMITED",
    "EXPEDIENT HEALTHCARE MARKETING PRIVATE LIMITED",
    "FA GIFTS PRIVATE LIMITED",
    "FAIRASSETS TECHNOLOGIES INDIA PRIVATE LIMITED",
    "FCC CLUTCH INDIA PRIVATE LIMITED",
    "FCS SOFTWARE SOLUTIONS LTD",
    "FENA PVT LTD",
    "FERNS N PETALS PVT LTD",
    "FIA TECHNOLOGY SERVICES PRIVATE LIMITED",
    "FINCFRIENDS PRIVATE LIMITED",
    "FINDI INDIA LIMITED",
    "FINDOC INVESTMART IFSC PRIVATE LIMITED",
    "FINDOC INVESTMART PRIVATE LIMITED",
    "FIVD INDIA CONSULTING PRIVATE LIMITED",
    "FLAKTGROUP INDIA PRIVATE LIMITED",
    "FLEXIDIGITAL TECH INDIA PRIVATE LIMITED",
    "FLUID3 INFOTECH PRIVATE LIMITED",
    "FNP E RETAIL PRIVATE LIMITED",
    "FONABIT INDIA PRIVATE LIMITED",
    "FRANKFINN AVIATION SERVICES PRIVATE LIMITED",
    "FRESENIUS MEDICAL CARE INDIA PRIVATE LIMITED",
    "FUSION FINANCE LIMITED",
    "G R INFRAPROJECTS LIMITED",
    "G4S SECURE SOLUTIONS INDIA PRIVATE LIMITED",
    "GALACTIC TELEVISION & COMMUNICATIONS PRIVATE LIMITED",
    "GARTNER INDIA RESEARCH AND ADVISORY SERVICES PVT LTD",
    "GAURSONS INFRATECH PRIVATE LIMITED",
    "GC WEB VENTURES PRIVATE LIMITED",
    "GEODIS INDIA PRIVATE LIMITED",
    "GHL PHARMA & DIAGNOSTIC PRIVATE LIMITED",
    "GHV ADVANCED CARE PRIVATE LIMITED",
    "GIESECKE AND DEVRIENT INDIA PRIVATE LIMITED",
    "GLB ASSURE PRIVATE LIMITED",
    "GLOBAL CONTENT TRANSFORMATION PRIVATE LIMITED",
    "GLOBALLOGIC TECHNOLOGIES PVT LTD",
    "GLOBIVA SERVICES PRIVATE LIMITED",
    "GOALS101 DATA SOLUTIONS PRIVATE LIMITED",
    "GRACO INDIA PRIVATE LIMITED",
    "GRAVITON RESEARCH CAPITAL LLP",
    "GREEN GIRAFFE PRIVATE LIMITED",
    "GREY ORANGE INDIA PRIVATE LIMITED",
    "GYGY INFRADESIGN PRIVATE LIMITED",
    "H AND M HENNES AND MAURITZ INDIA PVT LTD",
    "H AND M HENNES AND MAURITZ RETAIL PRIVATE LIMITED",
    "HAIER APPLIANCES INDIA PRIVATE LIMITED",
    "HALDIRAM BHUJIAWALA LTD",
    "HAVELLS INDIA LIMITED",
    "HEIDELBERG CEMENT INDIA LTD",
    "HELLO VERIFY INDIA PRIVATE LIMITED",
    "HIGHSPRING INDIA LLP",
    "HI-LEX INDIA PRIVATE LIMITED",
    "HINDUSTAN LATEX FAMILY PLANNING PROMOTION TRUST",
    "HITACHI LIFT INDIA PRIVATE LIMITED",
    "HITACHI SYSTEMS INDIA PRIVATE LIMITED",
    "HOLIDAY TRIANGLE TRAVEL PRIVATE LIMITED",
    "HONASA CONSUMER LIMITED",
    "HPL ELECTRIC AND POWER LIMITED",
    "HT MEDIA LIMITED",
    "HT MEDIA LTD",
    "HUNCH CIRCLE PRIVATE LIMITED",
    "I ENERGIZER IT SERVICES PRIVATE LIMITED",
    "IANS INDIA PRIVATE LIMITED",
    "IDAM NATURAL WELLNESS PRIVATE LIMITED",
    "IDP EDUCATION INDIA PRIVATE LIMITED",
    "IENERGIZER IT SERVICES PRIVATE LIMITED",
    "IFFCO KISAN FINANCE LIMITED",
    "IFFCO-TOKIO GENERAL INSURANCE COMPANY LIMITED",
    "IKEDA LIMITED",
    "IKM INVESTORS PRIVATE LIMITED",
    "INCRED FINANCIAL SERVICES LIMITED",
    "INCREDIBLE MANAGEMENT SERVICES PRIVATE LIMITED",
    "INCUSPAZE SOLUTIONS PRIVATE LIMITED",
    "INDEEPAY TECHNOLOGIES PRIVATE LIMITED",
    "INDIA EXPOSITION MART LIMITED",
    "INDIA SHELTER FINANCE CORPORATION LIMITED",
    "INDIA YAMAHA MOTOR PRIVATE LIMITED",
    "INDIAN ENERGY EXCHANGE LIMITED",
    "INDIAN METALS AND FERRO ALLOYS LTD",
    "INDIFI TECHNOLOGIES PRIVATE LIMITED",
    "INDITEX TRENT RETAIL INDIA PRIVATE LIMITED",
    "INDORAMA INDIA PRIVATE LIMITED",
    "INDRAPRASTHA CANCER SOCIETY AND RESEARCH CENTRE",
    "INFO EDGE INDIA LIMITED",
    "INFO EDGE INDIA LTD",
    "INNODATA INDIA PRIVATE LIMITED",
    "INNOVA AM TECH PRIVATE LIMITED",
    "INSTANT TRANSPORT SOLUTION PRIVATE LIMITED",
    "INTERARCH BUILDING SOLUTIONS LIMITED",
    "INTERNATIONAL CENTRE FOR AUTOMOTIVE TECHNOLOGY",
    "INTERNATIONAL MANAGEMENT INSTITUTE",
    "ISERVEU TECHNOLOGY PRIVATE LIMITED",
    "ISGEC HEAVY ENGINEERING LIMITED",
    "ISON XPERIENCES INDIA PRIVATE LIMITED",
    "JAKSON LIMITED",
    "JAQUAR AND COMPANY PRIVATE LIMITED",
    "JAY SWITCHES INDIA PRIVATE LIMITED",
    "JBM AUTO LIMITED",
    "JIO INSURANCE BROKING LIMITED",
    "JIVA AYURVEDIC PHARMACY LIMITED",
    "JM JAIN LLP",
    "KAJARIA BATHWARE PRIVATE LIMITED",
    "KALINGA INSTITUTE OF INDUSTRIAL TECHNOLOGY",
    "KANADOO LLP",
    "KARCHER CLEANING SYSTEMS PRIVATE LIMITED",
    "KAYNES TECHNOLOGY INDIA LIMITED",
    "KIMBAL PRIVATE LIMITED",
    "KSOLVES INDIA LIMITED",
    "KUSUM HEALTHCARE PVT LTD",
    "LAMBDATEST INDIA PRIVATE LIMITED",
    "LE TRAVENUES TECHNOLOGY LIMITED",
    "LEIXIR RESOURCES PRIVATE LIMITED",
    "LENSKART EYETECH PRIVATE LIMITED",
    "LENSKART SOLUTIONS LIMITED",
    "LEX ORBIS CONSULTING PRIVATE LIMITED",
    "LIVPURE PVT LTD",
    "LLOYDS METALS AND ENERGY LTD",
    "LOCON SOLUTIONS PRIVATE LIMITED",
    "LOGIC FRUIT TECHNOLOGIES PRIVATE LIMITED",
    "LOGILE INDIA PRIVATE LIMITED",
    "LOHUM CATALYSTS PRIVATE LIMITED",
    "M.B.A. CONSULTING INDIA PRIVATE LIMITED",
    "MAGIC SOFTWARE PVT LTD",
    "MANGALMAY FOUNDATION TRUST",
    "MANPOWERGROUP SERVICES INDIA PVT LTD",
    "MARELLI INDIA PRIVATE LIMITED",
    "MARG ERP LIMITED",
    "MARKYTICS CONSULTING PRIVATE LIMITED",
    "MASIBUS AUTOMATION AND INSTRUMENTATION PRIVATE LIMITED",
    "MASSIMO DUTTI INDIA PRIVATE LIMITED",
    "MASTER CAPITAL SERVICES LTD",
    "MAX ASSET SERVICES LIMITED",
    "MAYBRIGHT VENTURES PRIVATE LIMITED",
    "MB POWER MADHYA PRADESH LIMITED",
    "MEDIATEK BANGALORE PRIVATE LIMITED",
    "MEDIATEK INDIA TECHNOLOGY PRIVATE LIMITED",
    "MERABO LABS PVT LTD",
    "MERKUR GAMING INDIA PRIVATE LIMITED",
    "METRO INSTITUTES OF MEDICAL SCIENCES PRIVATE LIMITED",
    "METRO SPECIALITY HOSPITALS PRIVATE LIMITED",
    "MIDEA INDIA PRIVATE LIMITED",
    "MILES EDUCATION PRIVATE LIMITED",
    "MIRAGGIO LIFESTYLES PRIVATE LIMITED",
    "MITSUBISHI ELECTRIC INDIA PRIVATE LIMITED",
    "MITSUBISHI ELECTRIC INDIA PVT LTD",
    "MOBILE PROGRAMMING INDIA PRIVATE LIMITED",
    "MODELAMA EXPORTS PRIVATE LIMITED",
    "MODICARE LIMITED",
    "MONEYMITRA IT SOLUTIONS PRIVATE LIMITED",
    "MOOZ OFFICES INDIA PRIVATE LIMITED",
    "MPOKKET FINANCIAL SERVICES PRIVATE LIMITED",
    "MPS LTD",
    "MYCLASSBOARD EDUCATIONAL SOLUTIONS PRIVATE LIMITED",
    "MYWISH MARKETPLACES PRIVATE LIMITED",
    "NAB GLOBAL INNOVATION CENTRE INDIA PRIVATE LIMITED",
    "NAT IT SERVICES PRIVATE LIMITED",
    "NETWAY INDIA PRIVATE LIMITED",
    "NEXT-GEN BUSINESS CONSULTANCY PRIVATE LIMITED",
    "NK SECURITIES RESEARCH PRIVATE LIMITED",
    "NLVD Assurance (OPC) Private Limited",
    "NLVD ASSURANCE OPC PRIVATE LIMITED",
    "NOIDA EXIM PRIVATE LIMITED",
    "NOPAPERFORMS SOLUTIONS LIMITED",
    "NORTHERN IT SERVICES PRIVATE LIMITED",
    "NOVARGI ENGINEERING PRIVATE LIMITED",
    "NRV DESIGNX PRIVATE LIMITED",
    "NSB BPO SOLUTIONS LIMITED",
    "NUKLEUS OFFICE SOLUTIONS LIMITED",
    "OCUBE SERVICES PRIVATE LIMITED",
    "OFFSHOOT AGENCY PRIVATE LIMITED",
    "OFFSHORE A ONE TECHNOLOGY PRIVATE LTD",
    "OFIS SPACES PRIVATE LIMITED",
    "OKAYA POWER PRIVATE LIMITED",
    "OM LOGISTICS LIMITED",
    "OM LOGISTICS SUPPLY CHAIN PRIVATE LIMITED",
    "OMRON AUTOMATION PRIVATE LIMITED",
    "ONIONDEV TECHNOLOGIES PRIVATE LIMITED",
    "ONWARD COWORKX PRIVATE LIMITED",
    "OPTUM GLOBAL SOLUTIONS INDIA PRIVATE LIMITED",
    "ORBIS FINANCIAL CORPORATION LIMITED",
    "OTOMASHEN IT SERVICES PRIVATE LIMITED",
    "OXYZO FINANCIAL SERVICES LIMITED",
    "PACIFIC DEVELOPMENT CORPORATION LIMITED",
    "PACIFIC WORLD FOUNDATION",
    "PARACOAT PRODUCTS LIMITED",
    "PARAHIT TECHNOLOGIES LIMITED",
    "PARK HOSPITALS",
    "PARVIOM TECHNOLOGIES PRIVATE LIMITED",
    "PAY10 SERVICES PRIVATE LIMITED",
    "PAYU DIGITAL LABS PRIVATE LIMITED",
    "PAYU PAYMENTS PRIVATE LIMITED",
    "PEARL GLOBAL INDUSTRIES LIMITED",
    "PEGEEN BUILDERS & DEVELOPERS PRIVATE LIMITED",
    "PERFECTUS TECHNOLOGY SOLUTIONS PRIVATE LIMITED",
    "PHILIPS GLOBAL BUSINESS SERVICES LLP",
    "PHILIPS INDIA LTD",
    "PHYSICSWALLAH LIMITED",
    "PI CREDIT SERVICES PRIVATE LIMITED",
    "PINE LABS LIMITED",
    "PINE LABS LTD",
    "PINE LABS PVT LTD",
    "PITNEY BOWES INDIA PRIVATE LIMITED",
    "PLANET EDU GLOBAL PRIVATE LIMITED",
    "PN MEMORIAL NEURO CENTRE AND RESEARCH INSTITUTE LIMITED",
    "POINT TO POINT CONSULTANTS LLP",
    "PORTWAY SOLUTIONS INDIA PRIVATE LIMITED",
    "PPAP AUTOMOTIVE LIMITED",
    "PRAGATI INFRA SOLUTIONS PRIVATE LIMITED",
    "PRATHAM BROADCAST INDIA PRIVATE LIMITED",
    "PROFICIENCY LEARNING SOLUTIONS PRIVATE LIMITED",
    "PROMETRIC TESTING PRIVATE LIMITED",
    "PROMOTION VALA",
    "PRUDENT INSURANCE BROKERS PRIVATE LIMITED",
    "PUNJAB AND SIND BANK",
    "PURERIDE TECHNOLOGIES PRIVATE LIMITED",
    "PURPLE WAVE INFOCOM LIMITED",
    "QUINTESSENTIALLY LIFESTYLE SERVICES INDIA PVT LTD",
    "QUORUM CLUB PRIVATE LIMITED",
    "R2WIN DIGITAL PRIVATE LIMITED",
    "RADIATE E-SERVICES PRIVATE LIMITED",
    "RADNIK EXPORTS GLOBAL PRIVATE LIMITED",
    "RAPIPAY FINTECH PRIVATE LIMITED",
    "RASHMI METALIKS LTD",
    "RATEGAIN TRAVEL TECHNOLOGIES LIMITED",
    "REAL TIME DATA SERVICES PRIVATE LIMITED",
    "REDCLIFFE HYGIENE PRIVATE LIMITED",
    "REDCLIFFE LIFETECH PRIVATE LIMITED",
    "REDTAPE LIMITED",
    "REGAAL RESOURCES LIMITED",
    "RELAXO FOOTWEARS LIMITED",
    "RENEW PRIVATE LIMITED",
    "RESILIENT PAYMENTS PRIVATE LIMITED",
    "REVFIN SERVICES PRIVATE LIMITED",
    "RHYTHM INNOVATIONS INDIA PRIVATE LIMITED",
    "RMSI PRIVATE LIMITED",
    "ROSMERTA TECHNOLOGIES LIMITED",
    "ROYAL SOFTECH INDIA PRIVATE LIMITED",
    "ROZANA RURAL COMMERCE PRIVATE LIMITED",
    "RSB TRANSMISSIONS I LTD",
    "RSM US INTEGRATED SERVICES INDIA PRIVATE LIMITED",
    "SAFE GLOBAL VENTURES PRIVATE LIMITED",
    "SAFE TECHNOLOGY INDIA PRIVATE LIMITED",
    "SAN SOFTWARES PRIVATE LIMITED",
    "SANDHAR ASCAST PRIVATE LIMITED",
    "SANDHAR TECHNOLOGIES LIMITED",
    "SANDHAR WHETRON ELECTRONICS PRIVATE LIMITED",
    "SATIN CREDITCARE NETWORK LIMITED",
    "SATYA MICROCAPITAL LIMITED",
    "SD BIOSENSOR HEALTHCARE PRIVATE LIMITED",
    "SDG SOFTWARE INDIA PRIVATE LIMITED",
    "SEABIRD LOGISOLUTIONS LIMITED",
    "SEKISUI DLJM MOLDING PRIVATE LIMITED",
    "SEMTECH ADVANCED SYSTEMS INDIA PRIVATE LIMITED",
    "SERVETEL INFOCOMM PRIVATE LIMITED",
    "SG FINSERVE LIMITED",
    "SHAHI EXPORTS PRIVATE LIMITED",
    "SHARP SIGHT LASER CENTRE PRIVATE LIMITED",
    "SHERAWAT INFOTECH PRIVATE LIMITED",
    "SHIVALIK BIMETAL CONTROLS LIMITED",
    "SHIVALIK SMALL FINANCE BANK LIMITED",
    "SHREE BHARAT INTERNATIONAL PRIVATE LIMITED",
    "SHUBHAM HOUSING DEVELOPMENT FINANCE COMPANY LIMITED",
    "SIDDHI TRADERS PRIVATE LIMITED",
    "SIERRA CLOUD LLP",
    "SIGNATUREGLOBAL COMTRADE PRIVATE LIMITED",
    "SILARIS INFORMATIONS INDIA PRIVATE LIMITED",
    "SILVER ARROW AUTOMOBILES PRIVATE LIMITED",
    "SIRION LABS PRIVATE LIMITED",
    "SIS CASH SERVICES LIMITED",
    "SIS LIMITED",
    "SKETS STUDIO PRIVATE LIMITED",
    "SKODA POWER PRIVATE LIMITED",
    "SKOOTR GLOBAL PRIVATE LIMITED",
    "SKY GATE HOSPITALITY PRIVATE LIMITED",
    "SKYLABS SOLUTION INDIA PRIVATE LIMITED",
    "SLEEP MANAGEMENT PRIVATE LIMITED",
    "SMARTWORLD DEVELOPERS PRIVATE LIMITED",
    "SMC CORPORATION INDIA PRIVATE LIMITED",
    "SMC GLOBAL SECURITIES LIMITED",
    "SMC INSURANCE BROKERS PRIVATE LIMITED",
    "SMC INSURANCE BROKERS PVT LTD",
    "SNVA TRAVELTECH LIMITED",
    "SOCIETY RAMAN EDUCATION",
    "SOLOMON CAPITAL PRIVATE LIMITED",
    "SOLUTIONS OFFSHOOT",
    "SONY INDIA PRIVATE LIMITED",
    "SOTERIA COMMAND CENTER PRIVATE LIMITED",
    "SOUTH ASIA FM LIMITED",
    "SPACK AUTOMOTIVES PRIVATE LIMITED",
    "SPECTRUM WIFIINTERNET WORLD INDIA PRIVATE LIMITED",
    "SPFL SECURITIES LIMITED",
    "SPHEREBOX INFRA PRIVATE LIMITED",
    "SQUARE YARDS TECHNOLOGY PRIVATE LIMITED",
    "SRS LIVE TECHNOLOGIES PRIVATE LIMITED",
    "SS SUPPLY CHAIN SOLUTIONS PRIVATE LIMITED",
    "STAREX FOUNDATION",
    "STARWOOD INDIA PRIVATE LIMITED",
    "STENERAL CONSULTING PRIVATE LIMITED",
    "STREAM DIGITAL SERVICES PRIVATE LIMITED",
    "STRIDE FINTREE PRIVATE LIMITED",
    "STRYKER GLOBAL TECHNOLOGY CENTER PRIVATE LIMITED",
    "STRYKER INDIA PVT LTD",
    "SUNBEAM LIGHTWEIGHTING SOLUTIONS PRIVATE LIMITED",
    "SUNRISE MENTORS PRIVATE LIMITED",
    "SUPREMEWORK INFRA SOLUTIONS PRIVATE LIMITED",
    "SURAKSHA DIAGNOSTIC LIMITED",
    "SURBANA JURONG INDIA PRIVATE LIMITED",
    "SWAMI INTERNATIONAL BACK OFFICE SERVICES PRIVATE LIMITED",
    "SWAN DEFENCE AND HEAVY INDUSTRIES LIMITED",
    "SYRMA JOHARI MEDTECH LIMITED",
    "TADANO CRANES INDIA PRIVATE LIMITED",
    "TAIKISHA ENGINEERING INDIA PRIVATE LIMITED",
    "TATA 1MG TECHNOLOGIES PRIVATE LIMITED",
    "TATWA TECHNOLOGIES LIMITED",
    "TBO TEK LIMITED",
    "TEAM VERTEX COSMOS PRIVATE LIMITED",
    "TECHNIP ENERGIES INDIA LTD",
    "TECHNOBUBBLE INNOVATION LAB PRIVATE LIMITED",
    "TEMPORA MUTANTUR PRIVATE LIMITED",
    "TENERIFE INNOVATIONS PRIVATE LIMITED",
    "THE INSTITUTE OF CHARTEREDACCOUNTANTS OF INDIA",
    "THRIVENI EARTHMOVERS AND INFRA PRIVATE LIMITED",
    "TO THE NEW PRIVATE LIMITED",
    "TOWARDS VISION TECHNOLOGIES LIMITED",
    "TOYO INK INDIA PRIVATE LIMITED",
    "TOYOTA FINANCIAL SERVICES INDIA LIMITED",
    "TRADEWALK BROKING PRIVATE LIMITED",
    "TRIDENT HILLS PRIVATE LIMITED",
    "TRIDENT INFRAHOMES PVT LTD",
    "TRILLIONLOANS FINTECH PRIVATE LIMITED",
    "TRUEVANTAGE BUSINESS SERVICES INDIA PRIVATE LIMITED",
    "TRUSTLINE SECURITIES LIMITED",
    "TRUWORX SPACES PRIVATE LIMITED",
    "TSYS CARD TECH SERVICES INDIA LLP",
    "TURBOML PRIVATE LIMITED",
    "TWINLINE BUSINESS SOLUTIONS PRIVATE LIMITED",
    "UNIPARTS INDIA LIMITED",
    "UNIQLO INDIA PRIVATE LIMITED",
    "UNIVO EDUCATION PRIVATE LIMITED",
    "URBAN COMPANY LIMITED",
    "URJA INVESTMENT PRIVATE LIMITED",
    "USMS SAFFRON CO INC",
    "V2 RETAIL LTD",
    "VAGMINE EDUCATION LLP",
    "VAMANI OVERSEAS PRIVATE LIMITED",
    "VARITE INDIA PRIVATE LIMITED",
    "VARYA CONSULTANTS PRIVATE LIMITED",
    "VASUDHAIVA KUTUMBAKAM GROUP PRIVATE LIMITED",
    "VATIKA BUSINESS CENTRES PRIVATE LIMITED",
    "VEDANT FASHIONS LIMITED",
    "VEDIC BROADCASTING LIMITED",
    "VEELINE INDUSTRIES LIMITED",
    "VEERSA TECHNOLOGIES INDIA PRIVATE LIMITED",
    "VERTIV ENERGY PVT LTD",
    "VIBRIUM AI PRIVATE LIMITED",
    "VICTORA AUTO PVT LTD",
    "VINFAST AUTO INDIA PRIVATE LIMITED",
    "VISIT HEALTH PRIVATE LIMITED",
    "VLCC LIMITED",
    "VLINK INDIA PRIVATE LIMITED",
    "VOICETREE TECHNOLOGIES PRIVATE LIMITED",
    "VOICETREE TELECOMMUNICATION PRIVATE LIMITED",
    "VOUCHAGRAM INDIA PRIVATE LIMITED",
    "VR SOUTH ASIA PRIVATE LIMITED",
    "WALSONS FACILITY SOLUTIONS PRIVATE LIMITED",
    "WALSONS HEALTHCARE PRIVATE LIMITED",
    "WALSONS SERVICES PRIVATE LIMITED",
    "WHEELSEYE TECHNOLOGY INDIA PRIVATE LIMITED",
    "XOOGLE GLOBAL TECHNOLOGIES PRIVATE LIMITED",
    "YASH TECHNOLOGIES PRIVATE LIMITED",
    "YESMADAM TECHNOLOGIES PRIVATE LIMITED",
    "YOKOHAMA INDIA PRIVATE LIMITED",
    "YUSEN LOGISTICS INDIA PRIVATE LIMITED",
    "ZOMATO HYPERPURE PRIVATE LIMITED",
    "ZONES CORPORATE SOLUTIONS PRIVATE LIMITED",
    "ZOOM INSURANCE BROKERS PRIVATE LIMITED",
    "ZUARI FINSERV LIMITED",
    "ZUARI INDUSTRIES LTD",
]


print(len(COMPANIES), "companies to research")

TTBS_CONTEXT = """
Tata Tele Business Services (TTBS) offerings:
- Business communications: Smartflo CCaaS, CPaaS, UCaaS, SIP Trunk, Toll-Free, WhatsApp Business, Enterprise RCS
- Connectivity: Smart Internet Leased Line (ILL), SD-WAN iFLX, P2P Leased Line, Ultra-LOLA, Managed Wi-Fi
- Cloud: TTBS Smart Cloud, Microsoft Azure and migration, CloudMon monitoring
- Cybersecurity: Email security, endpoint security/EDR, DLP, Managed SOC, VAPT
- Productivity: SmartOffice, Vaultastic email archiving, Microsoft 365, Google Workspace
"""

OUTPUT_RULES = """
Return ONLY this exact format for the company:

COMPANY NAME
Key signals: <1-2 short lines; only TTBS-relevant signals how it can be algined x what TTBS offering; bold main keywords>
Opportunity type: <1-2 short lines; only TTBS-relevant opportunity; bold main keywords>
Recommended outreach approach: <1-2 short lines; only TTBS-relevant sales action; bold main keywords>

STRICT RELEVANCE FILTER:
Include a news item ONLY if it creates a clear, direct business need for one or more TTBS offerings.

INCLUDE only signals connected to:
- New offices, plants, warehouses, data centers, branches, retail stores, hospitals, campuses or remote sites
- Manufacturing, mining, logistics, multi-location or distributed-workforce expansion
- Funding, capex, acquisitions or contracts that indicate operational or IT scale-up but not stock market performance, investment commentary or general financial results
- Leadership changes only when the new leader explicitly owns IT, digital, transformation, security, operations
- Cloud, ERP, CRM, data platform, AI/GenAI, application modernization, VDI or digital transformation
- Cybersecurity, data protection, compliance, audit, SOC, VAPT, ransomware, phishing or data-loss risk
- Network performance, uptime, branch connectivity, remote-site access, SD-WAN, leased line or Wi-Fi needs
- Customer support, contact center, field-force communication, WhatsApp/RCS engagement or unified collaboration
- Determine expanstion or transformation needs from credible news, filings, announcements, interviews, hiring, recruitment and professional-platform updates

EXCLUDE these unless they have a direct TTBS connection:
- Routine share-price movement, daily stock commentary or technical analysis
- General financial results without an IT, connectivity, expansion or transformation implication
- Court cases, legal notices, regulatory disputes, penalties or tax matters
- CSR, advertising campaigns, awards, sponsorships, product launches or PR activity
- Routine news bulletins, content publication, hiring alone, or general business commentary
- Leadership appointments unrelated to technology, digital, security, operations or transformation
- Outside india news must
- Does not aligned or can not be aligned with Tata Tele Business Services (TTBS) offerings

RELEVANCE TEST:
Before including any signal, ask:
"Does this news create a clear opportunity for TTBS to sell connectivity, cloud, cybersecurity, communications, monitoring or workplace productivity?"
If the answer is NO, exclude it.

If no qualifying news is found in the research window, return exactly:
Key signals: Details not found
Opportunity type: Details not found
Recommended outreach approach: Details not found

Other rules:
1. Research only credible news, filings, announcements, interviews and professional-platform updates from the previous 10 days.
2. Keep every section short, factual and direct.
3. Include source URLs inline in each non-empty section.
4. Do not add explanations, headings, tables or extra commentary.
"""


def build_prompt(company: str, start_date: str, end_date: str) -> str:
    return f"""
Research the company: {company}

Research window: {start_date} to {end_date} (previous 10 days, inclusive).

Business context:
Identify only the operational, technology, expansion and security context needed to assess TTBS relevance.

TTBS context:
{TTBS_CONTEXT}

Focus only on these indicators:
1. Financial Updates: investments, funding, acquisitions, major contracts, capex and financial developments that indicate operational or IT scale-up.
2. Expansion Updates: new locations, plants, facilities, branches, warehouses, data centers, partnerships, capacity expansion and growth initiatives.
3. Leadership Changes: only appointments or movements of CIO, CTO, CDO, CISO, Head-IT, Head-Digital, Head-Transformation or technology/security/operations leaders.
4. IT & Digital Strategy: cloud, AI/GenAI, cybersecurity, data, digital transformation, application modernization, ERP/CRM, network modernization and major technology initiatives.

Apply the STRICT RELEVANCE FILTER before including any signal.

{OUTPUT_RULES}
"""

def research_company(company: str) -> str:
    end_date = datetime.utcnow().date()
    start_date = end_date - timedelta(days=10)

    payload = {
        # "preset": "high",  # Valid: fast, low, medium, high, xhigh
        "model": "anthropic/claude-haiku-5-5",
        "input": build_prompt(
            company,
            start_date.isoformat(),
            end_date.isoformat(),
        ),
        "instructions": (
            "You are a precise B2B sales-intelligence researcher for Tata Tele Business "
            "Services. Research only credible public sources. Use web search for recent "
            "news and follow the requested output format exactly."
        ),
        "tools": [{"type": "web_search"}],
        # "max_steps": 5,
        # "temperature": 0.2,
        "max_output_tokens": 50000,
    }

    response = post_with_retry(payload)

    # Print the real API error if Perplexity rejects the request
    if response.status_code != 200:
        raise RuntimeError(
            f"Perplexity API error {response.status_code}: {response.text}"
        )

    data = response.json()

    print(f"Perplexity response for {company}: {json.dumps(data, indent=2)}")

    with open('response_{}.json'.format(company), 'w+') as file:
        file.write(json.dumps(data))
        

    if data.get("status") not in ("completed", "in_progress"):
        raise RuntimeError(f"Perplexity response failed: {data.get('error')}")

    # Extract the assistant message text
    for item in data.get("output", []):
        if item.get("type") == "message":
            for content in item.get("content", []):
                if content.get("type") == "output_text":
                    return content["text"].strip()

    return "Details not found"


def safe_research(company: str) -> str:
    """Run research for one company (worker thread); never raises."""
    try:
        return research_company(company)
    except Exception as exc:
        return (
            f"{company.upper()}\n"
            "Key signals: Research failed due to API error.\n"
            "Opportunity type: Research failed due to API error.\n"
            "Recommended outreach approach: Research failed due to API error.\n"
            f"Error: {exc}"
        )


PRIORITY_ACTION_RULES = """
Create a prioritized TTBS sales action list from the company research results.

Return ONLY entries in this exact format:

COMPANY NAME
Why now? <1-2 short lines explaining the immediate trigger, urgency and TTBS-relevant need>
Action: <1-2 short lines with a specific sales action, target stakeholder and TTBS offerings>

Rules:
1. Rank companies by strength and recency of trigger: fresh news, funding, expansion, contracts, leadership changes, cloud/AI/cybersecurity initiatives.
2. Give highest priority to companies with clear, recent, actionable signals.
3. Companies with 'Details not found' should be ignored.
4. Keep every entry short, direct and sales-ready.
5. Mention only TTBS-relevant offerings: ILL, SD-WAN, P2P, Managed Wi-Fi, CloudMon, Smart Cloud, Azure, managed SOC, endpoint security, DLP, email security, VAPT, Smartflo CCaaS/CPaaS/UCaaS, WhatsApp Business, Microsoft 365/Google Workspace.
6. Do not include source links, tables, explanations, or extra commentary.
7. Write COMPANY NAME exactly as it appears in the research results, on its own line, without numbering or formatting.
"""


def create_priority_actions(all_results: str) -> str:
    payload = {
        # "preset": "medium",
        "model": "anthropic/claude-haiku-5-5",
        "input": f"""
Below are TTBS company research results.

{all_results}

{PRIORITY_ACTION_RULES}
""",
        "instructions": (
            "You are a senior B2B sales strategist for Tata Tele Business Services. "
            "Convert research findings into a concise, prioritized sales-action list."
        ),
        # "max_steps": 3,
        # "temperature": 0.2,
        "max_output_tokens": 50000,
    }

    response = post_with_retry(payload)

    if response.status_code != 200:
        raise RuntimeError(
            f"Perplexity API error {response.status_code}: {response.text}"
        )

    data = response.json()

    with open('priority_actions_response.json', 'w+') as file:
        file.write(json.dumps(data))

    for item in data.get("output", []):
        if item.get("type") == "message":
            for content in item.get("content", []):
                if content.get("type") == "output_text":
                    return content["text"].strip()

    return "Details not found"


def _normalize(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", text.upper())


def _match_company(line: str):
    """Return the company from COMPANIES that this header line refers to, else None."""
    key = _normalize(line)
    if not key:
        return None
    for company in COMPANIES:
        name = _normalize(company)
        if name == key or name in key or (len(key) >= 6 and key in name):
            return company
    return None


def parse_priority_actions(text: str):
    """Split priority-action text into {company: action_text}, keeping rank order."""
    actions, order, current = {}, [], None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        lowered = stripped.lstrip("*#-0123456789. ").lower()
        if not lowered.startswith(("why now", "action")):
            company = _match_company(stripped)
            if company:
                current = company
                if company not in actions:
                    order.append(company)
                    actions[company] = []
                continue
        if current:
            actions[current].append(stripped)
    return order, {c: "\n".join(lines) for c, lines in actions.items()}


def clean_news_result(company: str, text: str) -> str:
    """Drop the company header line; return empty when there is no usable data."""
    if not text or "Details not found" in text or "Research failed" in text:
        return ""
    lines = text.strip().splitlines()
    if lines and _match_company(lines[0]) == company:
        lines = lines[1:]
    return "\n".join(lines).strip()


def save_csv(results: dict, priority_actions: str, output_file: str) -> None:
    order, actions = parse_priority_actions(priority_actions)
    # Prioritized companies first (in rank order), then the rest in original order
    sorted_companies = order + [c for c in COMPANIES if c not in actions]

    with open(output_file, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Company", "News Feed Results", "Priority Actions"])
        for company in sorted_companies:
            writer.writerow([
                company,
                clean_news_result(company, results.get(company, "")),
                actions.get(company, ""),
            ])


def main():
    end_date = datetime.utcnow().date()
    start_date = end_date - timedelta(days=10)
    header = f"TTBS Company Signal Research | {start_date} to {end_date}"
    print(header + "\n")

    # One thread per company
    results = {}
    with ThreadPoolExecutor(max_workers=len(COMPANIES)) as executor:
        futures = {executor.submit(safe_research, c): c for c in COMPANIES}
        for future in as_completed(futures):
            company = futures[future]
            results[company] = future.result()
            print(f"Done: {company}")

    # Combine in the original company order
    separator = "=" * 100
    combined = (
        header + "\n\n"
        + "\n\n".join(f"{separator}\n{results[c]}" for c in COMPANIES)
        + "\n"
    )

    # # Create priority actions for each companya
    priority_actions = create_priority_actions(combined)
    combined += f"\n\n{separator}\n\nPRIORITY ACTIONS\n\n{""}\n"

    output_file = f"ttbs_research_{end_date}.txt"
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(combined)

    print(f"\nCombined results saved to {output_file}")

    csv_file = f"ttbs_research_{end_date}.csv"
    save_csv(results, priority_actions, csv_file)
    print(f"CSV saved to {csv_file}")


if __name__ == "__main__":
    main()