from __future__ import annotations

from collections.abc import Iterable


def extract_embedding(response: object, expected_dimension: int | None = None) -> list[float]:
    if not isinstance(response, dict):
        raise TypeError("Embedding response must be an object")
    data = response.get("data")
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
        raise ValueError("Embedding response contains no data")
    vector = data[0].get("embedding")
    if not isinstance(vector, list) or not all(isinstance(value, (int, float)) for value in vector):
        raise ValueError("Embedding response contains no numeric vector")
    result = [float(value) for value in vector]
    if expected_dimension is not None and len(result) != expected_dimension:
        raise ValueError(
            f"Expected embedding dimension {expected_dimension}, received {len(result)}"
        )
    return result


def extract_embeddings(
    response: object, expected_dimension: int | None = None
) -> list[list[float]]:
    if not isinstance(response, dict) or not isinstance(response.get("data"), list):
        raise TypeError("Embedding response contains no data")
    return [
        extract_embedding({"data": [item]}, expected_dimension)
        for item in response["data"]
        if isinstance(item, dict)
    ]


def embedding_dimension(vector: Iterable[float]) -> int:
    return len(list(vector))
