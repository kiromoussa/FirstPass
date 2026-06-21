"""Address parsing and city-specific source profiles."""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class JurisdictionProfile:
    city: str
    state: str
    slug: str
    supported: bool
    municipal_seed_urls: list[str] = field(default_factory=list)
    parcel_lookup_url: str | None = None
    municode_host: str | None = None
    official_domains: list[str] = field(default_factory=list)
    unsupported_message: str | None = None


CITY_REGISTRY: dict[str, dict] = {
    "los angeles": {
        "slug": "los_angeles",
        "municode_host": "library.municode.com/ca/los_angeles",
        "official_domains": ["lacity.gov", "ladbs.org", "ladbs.lacity.gov", "planning.lacity.gov", "library.municode.com", "amlegal.com"],
        "municipal_seed_urls": [
            "https://www.ladbs.org/services/accessory-dwelling-units-adu",
            "https://planning.lacity.gov/plans-policies/initiatives-policies/accessory-dwelling-units",
            "https://library.municode.com/ca/los_angeles/codes/code_of_ordinances?nodeId=TIT12PLCO",
            "https://codelibrary.amlegal.com/codes/los_angeles/latest/lamc/0-0-0-109645",
        ],
        "parcel_lookup_url": "https://zimas.lacity.org/",
    },
    "oakland": {
        "slug": "oakland",
        "municode_host": "library.municode.com/ca/oakland",
        "official_domains": ["oaklandca.gov", "library.municode.com"],
        "municipal_seed_urls": [
            "https://www.oaklandca.gov/My-Household/Building-and-Remodeling/Homeowner-Projects-Permits/Accessory-Dwelling-Units-ADUs/ADU-with-Single-Family-Home",
            "https://www.oaklandca.gov/My-Household/Building-and-Remodeling/Homeowner-Projects-Permits/Accessory-Dwelling-Units-ADUs",
            "https://library.municode.com/ca/oakland/codes/code_of_ordinances?nodeId=TIT17PLCO",
        ],
        "parcel_lookup_url": "https://gisapps.oaklandca.gov/parcel/",
    },
}


def parse_city_from_address(address: str) -> str:
    """Extract city name from a US address string."""
    address = address.strip()
    if not address:
        return ""

    # "Los Angeles, CA" or "Oakland, CA 94610"
    two_part = re.match(r"^([^,]+),\s*([A-Za-z]{2})\b", address)
    if two_part and not re.search(r"\d", two_part.group(1)):
        return two_part.group(1).strip()

    # "1216 E 92nd St, Los Angeles, CA 90002"
    parts = [p.strip() for p in address.split(",")]
    if len(parts) >= 3:
        return parts[-2]

    if len(parts) == 2:
        return parts[0]

    return ""


def parse_state_from_address(address: str, default: str = "CA") -> str:
    match = re.search(r",\s*([A-Za-z]{2})\b", address)
    return match.group(1).upper() if match else default


def resolve_jurisdiction(city: str, state: str = "CA") -> JurisdictionProfile:
    """Return source profile for a city, or unsupported placeholder."""
    key = city.strip().lower()
    entry = CITY_REGISTRY.get(key)
    if entry:
        return JurisdictionProfile(
            city=city.strip(),
            state=state.upper(),
            slug=entry["slug"],
            supported=True,
            municipal_seed_urls=list(entry["municipal_seed_urls"]),
            parcel_lookup_url=entry.get("parcel_lookup_url"),
            municode_host=entry.get("municode_host"),
            official_domains=list(entry["official_domains"]),
        )

    return JurisdictionProfile(
        city=city.strip() or "Unknown",
        state=state.upper(),
        slug="unsupported",
        supported=False,
        unsupported_message=(
            f"Municipal research for '{city}' is not yet configured. "
            "Only Los Angeles and Oakland have curated official sources. "
            "State-level ADU statutes still apply."
        ),
    )


def resolve_from_address(address: str) -> JurisdictionProfile:
    city = parse_city_from_address(address)
    state = parse_state_from_address(address)
    return resolve_jurisdiction(city, state)


def is_official_municipal_source(url: str, profile: JurisdictionProfile) -> bool:
    """True if URL host matches city's official domains or Municode for that city."""
    if not url:
        return False
    url_lower = url.lower()
    for domain in profile.official_domains:
        if domain in url_lower:
            return True
    if profile.municode_host and profile.municode_host in url_lower:
        return True
    return False
