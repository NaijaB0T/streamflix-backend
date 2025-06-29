import requests
import json
import asyncio
import websockets
import time

# --- Configuration ---
BASE_URL = "http://localhost:8787/api"
# This is a long-lived token generated from a previous login for testing purposes.
# In a real test suite, you would programmatically log in to get a fresh token.
AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjEsInR3aXRjaF9pZCI6IjYxMzY4MDg4MCIsImV4cCI6MTc1MTgwMTA5NX0.t6dRjTEIdOR0zDUJyw3RC4aX22D06ooQwhUaGO_5zb0"
ADMIN_SECRET = "Control11@yahoo.com"
# These will be updated dynamically in the main execution block
TOURNAMENT_ID = None
MATCH_ID = None
VOTE_EVENT_ID = None

# --- Helper Functions ---
def print_test_title(title):
    print(f"\n{'='*10} {title} {'='*10}")

def print_response(name, response):
    print(f"--- {name} ---")
    print(f"Status Code: {response.status_code}")
    try:
        print("Response JSON:")
        print(json.dumps(response.json(), indent=2))
    except json.JSONDecodeError:
        print("Response Text:")
        print(response.text)
    print("-" * (len(name) + 8))

# --- Test Functions ---

def test_tournament_endpoints():
    print_test_title("Testing Tournament Endpoints")
    cookies = {'auth_token': AUTH_TOKEN}

    # Test registering for a tournament
    response = requests.post(f"{BASE_URL}/tournaments/{TOURNAMENT_ID}/register", cookies=cookies)
    print_response("Register for Tournament", response)

    # Test getting registration status
    response = requests.get(f"{BASE_URL}/tournaments/{TOURNAMENT_ID}/my-registration-status", cookies=cookies)
    print_response("Get My Registration Status", response)

def test_admin_endpoints():
    print_test_title("Testing Admin Endpoints")
    headers = {'X-Admin-Secret': ADMIN_SECRET}

    # Test getting registrations
    response = requests.get(f"{BASE_URL}/admin/{TOURNAMENT_ID}/registrations", headers=headers)
    print_response("Admin: Get Registrations", response)

    # Test confirming participants (this will likely fail if you don't have 36 real pending users)
    # Note: The user IDs here are just examples.
    participant_ids = list(range(1, 37))
    response = requests.post(
        f"{BASE_URL}/admin/{TOURNAMENT_ID}/confirm-participants",
        headers=headers,
        json={"participantIds": participant_ids}
    )
    print_response("Admin: Confirm Participants", response)

    # Test starting a vote
    vote_data = {
        "points_award": 100,
        "cost_per_vote": 10,
        "duration_seconds": 60
    }
    response = requests.post(
        f"{BASE_URL}/admin/matches/{MATCH_ID}/start-vote",
        headers=headers,
        json=vote_data
    )
    print_response("Admin: Start Vote", response)
    global VOTE_EVENT_ID
    if response.status_code == 200:
        VOTE_EVENT_ID = response.json()['event']['id']

async def test_websocket_connection():
    print_test_title("Testing WebSocket Connection")
    uri = f"ws://localhost:8787/api/users/connect"
    headers = {'Cookie': f'auth_token={AUTH_TOKEN}'}

    try:
        async with websockets.connect(uri, extra_headers=headers) as websocket:
            print("WebSocket connection established successfully.")

            # Send a message
            await websocket.send("Hello, WebSocket!")
            print("Sent: Hello, WebSocket!")

            # Receive a message
            response = await websocket.recv()
            print(f"Received: {response}")

            print("WebSocket test passed.")
    except Exception as e:
        print(f"WebSocket test failed: {e}")

# --- Main Execution ---
if __name__ == "__main__":
    # THIS LINE WAS REMOVED. It is not needed at the module's top-level scope.
    # global TOURNAMENT_ID, MATCH_ID

    print("Starting comprehensive API test suite...")

    # Create Tournament and Match for testing
    print("\n--- Setting up Test Data ---")
    headers = {'X-Admin-Secret': ADMIN_SECRET}
    cookies = {'auth_token': AUTH_TOKEN}

    # Create Tournament via API
    print("Creating Test Tournament via API...")
    tournament_data = {
        "name": "Test Tournament",
        "status": "REGISTRATION_OPEN"
    }
    response = requests.post(f"{BASE_URL}/admin/tournaments", headers=headers, json=tournament_data)
    print_response("Create Tournament", response)
    if response.status_code != 201:
        print("Failed to create tournament via API. Exiting.")
        exit(1)
    TOURNAMENT_ID = response.json()['tournament']['id']
    time.sleep(1) # Give the DB a moment to process the insert

    # Create Users via API
    print("Creating Test User 1 via API...")
    user_data_1 = {
        "twitch_id": "613680880",
        "twitch_username": "testuser1",
        "twitch_profile_image_url": "http://example.com/testuser1.png"
    }
    response = requests.post(f"{BASE_URL}/admin/users", headers=headers, json=user_data_1)
    print_response("Create User 1", response)
    if response.status_code != 201:
        print("Failed to create user 1 via API. Exiting.")
        exit(1)
    user_1_id_actual = response.json()['user']['id']
    time.sleep(1)

    print("Creating Test User 2 via API...")
    user_data_2 = {
        "twitch_id": "613680881",
        "twitch_username": "testuser2",
        "twitch_profile_image_url": "http://example.com/testuser2.png"
    }
    response = requests.post(f"{BASE_URL}/admin/users", headers=headers, json=user_data_2)
    print_response("Create User 2", response)
    if response.status_code != 201:
        print("Failed to create user 2 via API. Exiting.")
        exit(1)
    user_2_id_actual = response.json()['user']['id']
    time.sleep(1)

    # Register users for tournament
    print("Registering User 1 for Tournament...")
    # Note: The AUTH_TOKEN is for user 1 (sub:1), so this registration will be for user 1.
    response = requests.post(f"{BASE_URL}/tournaments/{TOURNAMENT_ID}/register", cookies=cookies)
    print_response("Register User 1 for Tournament", response)
    if response.status_code not in [201, 409]: # 409 if already registered
        print("Failed to register user 1 for tournament. Exiting.")
        exit(1)
    # Get registration ID for User 1
    print("Fetching Registration ID for User 1...")
    response = requests.get(f"{BASE_URL}/admin/registrations/user/{user_1_id_actual}/tournament/{TOURNAMENT_ID}", headers=headers)
    print_response("Get Registration 1 ID", response)
    if response.status_code != 200:
        print("Failed to get registration ID for user 1. Exiting.")
        exit(1)
    registration_1_id_actual = response.json()['registration_id']
    time.sleep(1)

    print("Creating Registration for User 2 via API...")
    registration_data_2 = {
        "user_id": user_2_id_actual,
        "tournament_id": TOURNAMENT_ID,
        "status": "PENDING"
    }
    response = requests.post(f"{BASE_URL}/admin/registrations", headers=headers, json=registration_data_2)
    print_response("Create Registration 2", response)
    if response.status_code != 201:
        print("Failed to create registration for user 2 via API. Exiting.")
        exit(1)
    registration_2_id_actual = response.json()['registration']['id']
    time.sleep(1)

    # Create Tournament Participants via API
    print("Creating Tournament Participant for User 1 via API...")
    participant_data_1 = {
        "registration_id": registration_1_id_actual,
        "user_id": user_1_id_actual,
        "tournament_id": TOURNAMENT_ID,
        "status": "ACTIVE"
    }
    response = requests.post(f"{BASE_URL}/admin/participants", headers=headers, json=participant_data_1)
    print_response("Create Participant 1", response)
    if response.status_code != 201:
        print("Failed to create participant 1 via API. Exiting.")
        exit(1)
    participant_1_id_actual = response.json()['participant']['id']
    time.sleep(1)

    print("Creating Tournament Participant for User 2 via API...")
    participant_data_2 = {
        "registration_id": registration_2_id_actual,
        "user_id": user_2_id_actual,
        "tournament_id": TOURNAMENT_ID,
        "status": "ACTIVE"
    }
    response = requests.post(f"{BASE_URL}/admin/participants", headers=headers, json=participant_data_2)
    print_response("Create Participant 2", response)
    if response.status_code != 201:
        print("Failed to create participant 2 via API. Exiting.")
        exit(1)
    participant_2_id_actual = response.json()['participant']['id']
    time.sleep(1)

    # Create Match via API
    print("Creating Test Match via API...")
    match_data = {
        "tournament_id": TOURNAMENT_ID,
        "phase": "LEAGUE",
        "status": "SCHEDULED",
        "player_a_participant_id": participant_1_id_actual,
        "player_b_participant_id": participant_2_id_actual,
        "scheduled_at": "2025-06-29T10:00:00Z" # Example date, adjust as needed
    }
    response = requests.post(f"{BASE_URL}/admin/matches", headers=headers, json=match_data)
    print_response("Create Match", response)
    if response.status_code != 201:
        print("Failed to create match via API. Exiting.")
        exit(1)
    MATCH_ID = response.json()['match']['id']
    print("--- Test Data Setup Complete ---")

    try:
        test_tournament_endpoints()
        test_admin_endpoints()

        # Run the async websocket test
        asyncio.run(test_websocket_connection())
    finally:
        print("\n--- Cleaning up Test Data ---")
        # Delete VoteEvent via API (if created)
        if VOTE_EVENT_ID:
            print("Deleting Test VoteEvent via API...")
            response = requests.delete(f"{BASE_URL}/admin/vote-events/{VOTE_EVENT_ID}", headers=headers)
            print_response("Delete VoteEvent", response)

        # Delete Match via API
        print("Deleting Test Match via API...")
        response = requests.delete(f"{BASE_URL}/admin/matches/{MATCH_ID}", headers=headers)
        print_response("Delete Match", response)

        # Delete Tournament Participants via API
        print("Deleting Test Participants via API...")
        response = requests.delete(f"{BASE_URL}/admin/participants/{participant_1_id_actual}", headers=headers)
        print_response("Delete Participant 1", response)
        response = requests.delete(f"{BASE_URL}/admin/participants/{participant_2_id_actual}", headers=headers)
        print_response("Delete Participant 2", response)

        # Delete Tournament Registrations via API
        print("Deleting Test Registrations via API...")
        response = requests.delete(f"{BASE_URL}/admin/registrations/{registration_1_id_actual}", headers=headers)
        print_response("Delete Registration 1", response)
        response = requests.delete(f"{BASE_URL}/admin/registrations/{registration_2_id_actual}", headers=headers)
        print_response("Delete Registration 2", response)

        # Delete Tournament via API
        print("Deleting Test Tournament via API...")
        response = requests.delete(f"{BASE_URL}/admin/tournaments/{TOURNAMENT_ID}", headers=headers)
        print_response("Delete Tournament", response)

        # Delete Users via API
        print("Deleting Test Users via API...")
        response = requests.delete(f"{BASE_URL}/admin/users/{user_1_id_actual}", headers=headers)
        print_response("Delete User 1", response)
        response = requests.delete(f"{BASE_URL}/admin/users/{user_2_id_actual}", headers=headers)
        print_response("Delete User 2", response)
        print("--- Test Data Cleanup Complete ---")

    print("\nTest suite finished.")
