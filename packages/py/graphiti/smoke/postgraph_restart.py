"""Manual smoke test for PostGraph CRUD, search, and embedded restart persistence."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from tempfile import TemporaryDirectory
from typing import Any

from dbx_tools.graphiti.database import _start_embedded_database
from dbx_tools.graphiti.postgraph.driver import PostGraphDriver
from graphiti_core.edges import EntityEdge
from graphiti_core.nodes import EntityNode
from graphiti_core.search.search_filters import SearchFilters


async def _open(home: str) -> tuple[Any, PostGraphDriver]:
    database = await _start_embedded_database(home)
    driver = PostGraphDriver(
        dsn=database.dsn,
        embedding_dim=3,
        connection_options=database.connection_options,
    )
    await driver.build_indices_and_constraints()
    return database, driver


async def _seed(home: str) -> tuple[str, str]:
    database, driver = await _open(home)
    try:
        person = EntityNode(
            name="Reggie Pierce",
            group_id="smoke",
            name_embedding=[1.0, 0.0, 0.0],
            summary="Databricks engineer",
        )
        company = EntityNode(
            name="Databricks",
            group_id="smoke",
            name_embedding=[0.0, 1.0, 0.0],
            summary="Data and AI company",
        )
        await person.save(driver)
        await company.save(driver)
        fact = EntityEdge(
            group_id="smoke",
            source_node_uuid=person.uuid,
            target_node_uuid=company.uuid,
            created_at=datetime.now(timezone.utc),
            name="WORKS_FOR",
            fact="Reggie Pierce works for Databricks",
            fact_embedding=[1.0, 1.0, 0.0],
        )
        await fact.save(driver)
        matches = await driver.search_interface.node_fulltext_search(
            driver,
            "Reggie Pierce",
            SearchFilters(),
            ["smoke"],
            10,
        )
        assert [node.uuid for node in matches] == [person.uuid]
        return person.uuid, fact.uuid
    finally:
        await driver.close()
        await database.close()


async def _verify_restart(home: str, person_uuid: str, fact_uuid: str) -> None:
    database, driver = await _open(home)
    try:
        person = await EntityNode.get_by_uuid(driver, person_uuid)
        fact = await EntityEdge.get_by_uuid(driver, fact_uuid)
        assert person.name == "Reggie Pierce"
        assert fact.fact == "Reggie Pierce works for Databricks"
        assert driver.build_fulltext_query("Reggie & Databricks") == "Reggie & Databricks"
    finally:
        await driver.close()
        await database.close()


async def main() -> None:
    """Run the smoke test outside the regular pytest suite."""
    with TemporaryDirectory(prefix="dbx-tools-graphiti-smoke-") as home:
        person_uuid, fact_uuid = await _seed(home)
        await _verify_restart(home, person_uuid, fact_uuid)
    print("PostGraph embedded restart smoke test passed")


if __name__ == "__main__":
    asyncio.run(main())
