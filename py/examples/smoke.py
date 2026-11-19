"""Live read-only smoke test. Reads only — it never prepares, signs, or sends anything.

Run:  PYTHONPATH=src python examples/smoke.py
"""

from polypad_agent import PolypadClient

client = PolypadClient(client_name="polypad-agent-smoke")

info = client.initialize()
server = info["serverInfo"]
print(f"server: {server['name']} v{server['version']} | protocol: {info['protocolVersion']}")

tools = client.list_tools()
print(f"tools: {len(tools)} — " + ", ".join(t["name"] for t in tools))

stats = client.stats()
print(f"stats: {stats}")
print("smoke OK — reads only, nothing prepared, signed, or sent.")
