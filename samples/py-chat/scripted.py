"""The samples' scripted weather "model", the same in every sample: no API key needed."""

import re
from typing import Any

TAIL = (
    "This answer comes from a scripted model, so the sample runs without an API key. Each word is a separate "
    "delta from the model. The sink batches them, publishes them to the run channel, and every open tab sees "
    "the same text. Reload the page while it types and it picks up where it left off."
)


def city_from(question: str) -> str | None:
    """The city after the last "in" in the question: "What is the weather in new york?" gives "New York"."""
    matches = re.findall(r"\bin\s+([A-Za-z][A-Za-z .'-]*)", question, re.IGNORECASE)
    raw = re.sub(r"[\s.'-]+$", "", matches[-1].strip()) if matches else ""
    return " ".join(w[0].upper() + w[1:].lower() for w in raw.split()) or None


def weather(city: str) -> dict[str, Any]:
    """Made-up weather that is always the same for the same city."""
    total = sum(ord(c) for c in city.lower() if "a" <= c <= "z")
    return {"city": city, "forecast": ["sunny", "cloudy", "rainy", "windy"][total % 4], "celsius": 5 + total % 25}


def answer(city: str | None) -> str:
    if city is None:
        return f"Ask me about the weather in a city, for example: what is the weather in Lisbon? {TAIL}"
    w = weather(city)
    return f"The forecast says it is {w['forecast']} in {w['city']} today, {w['celsius']} degrees. {TAIL}"
