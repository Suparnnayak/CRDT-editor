#include <emscripten/bind.h>
#include <string>
#include <vector>
#include <set>
#include <algorithm>

static const int BASE = 100;

struct CRDT_Character {
    std::string value;
    std::vector<int> position;
    int lamport_clock;
    std::string client_id;
    bool is_deleted;

    bool operator<(const CRDT_Character& other) const {
        if (position != other.position) {
            return position < other.position;
        }
        if (lamport_clock != other.lamport_clock) {
            return lamport_clock < other.lamport_clock;
        }
        return client_id < other.client_id;
    }
};

std::vector<int> generatePositionBetween(const std::vector<int>& before,
                                         const std::vector<int>& after) {
    std::vector<int> result;
    size_t i = 0;
    while (true) {
        int b = (i < before.size()) ? before[i] : 0;
        int a = (i < after.size()) ? after[i] : BASE;

        if (a - b > 1) {
            result.push_back(b + (a - b) / 2);
            return result;
        } else {
            result.push_back(b);
            ++i;
        }
    }
}

class CRDT_Engine {
private:
    std::set<CRDT_Character> document;
    int lamport_clock;
    std::string client_id;

public:
    CRDT_Engine(std::string id) : lamport_clock(0), client_id(id) {}

    CRDT_Character localInsert(int index, std::string value) {
        std::vector<int> before;
        std::vector<int> after;

        int visibleIndex = 0;
        bool foundAfter = false;

        for (const auto& ch : document) {
            if (ch.is_deleted) continue;

            if (visibleIndex == index) {
                after = ch.position;
                foundAfter = true;
                break;
            }
            before = ch.position;
            ++visibleIndex;
        }

        (void)foundAfter;

        std::vector<int> newPosition = generatePositionBetween(before, after);
        ++lamport_clock;

        CRDT_Character newChar;
        newChar.value = value;
        newChar.position = newPosition;
        newChar.lamport_clock = lamport_clock;
        newChar.client_id = client_id;
        newChar.is_deleted = false;

        document.insert(newChar);
        return newChar;
    }

    void remoteInsert(std::string value, std::vector<int> pos, int clock,
                      std::string site) {
        lamport_clock = std::max(lamport_clock, clock);

        CRDT_Character newChar;
        newChar.value = value;
        newChar.position = pos;
        newChar.lamport_clock = clock;
        newChar.client_id = site;
        newChar.is_deleted = false;

        document.insert(newChar);
    }

    CRDT_Character localDelete(int index) {
        int visibleIndex = 0;
        for (auto it = document.begin(); it != document.end(); ++it) {
            if (it->is_deleted) continue;
            if (visibleIndex == index) {
                CRDT_Character tombstone = *it;
                document.erase(it);
                tombstone.is_deleted = true;
                document.insert(tombstone);
                ++lamport_clock;
                return tombstone;
            }
            ++visibleIndex;
        }
        return CRDT_Character{};
    }

    void remoteDelete(std::vector<int> position, std::string client_id) {
        for (auto it = document.begin(); it != document.end(); ++it) {
            if (it->position == position && it->client_id == client_id) {
                CRDT_Character tombstone = *it;
                document.erase(it);
                tombstone.is_deleted = true;
                document.insert(tombstone);
                return;
            }
        }
    }

    void loadFromDatabase(std::string value, std::vector<int> position,
                          int lamport, std::string client, bool is_deleted) {
        CRDT_Character ch;
        ch.value = value;
        ch.position = position;
        ch.lamport_clock = lamport;
        ch.client_id = client;
        ch.is_deleted = is_deleted;

        document.insert(ch);
        lamport_clock = std::max(lamport_clock, lamport);
    }

    std::string getText() {
        std::string result;
        for (const auto& ch : document) {
            if (!ch.is_deleted) {
                result += ch.value;
            }
        }
        return result;
    }

    std::vector<CRDT_Character> exportState() {
        std::vector<CRDT_Character> out;
        out.reserve(document.size());
        for (const auto& ch : document) {
            out.push_back(ch);
        }
        return out;
    }
};

EMSCRIPTEN_BINDINGS(crdt_module) {
    emscripten::register_vector<int>("VectorInt");

    emscripten::value_object<CRDT_Character>("CRDT_Character")
        .field("value", &CRDT_Character::value)
        .field("position", &CRDT_Character::position)
        .field("lamport_clock", &CRDT_Character::lamport_clock)
        .field("client_id", &CRDT_Character::client_id)
        .field("is_deleted", &CRDT_Character::is_deleted);

    emscripten::register_vector<CRDT_Character>("VectorCharacter");

    emscripten::class_<CRDT_Engine>("CRDT_Engine")
        .constructor<std::string>()
        .function("localInsert", &CRDT_Engine::localInsert)
        .function("remoteInsert", &CRDT_Engine::remoteInsert)
        .function("localDelete", &CRDT_Engine::localDelete)
        .function("remoteDelete", &CRDT_Engine::remoteDelete)
        .function("loadFromDatabase", &CRDT_Engine::loadFromDatabase)
        .function("getText", &CRDT_Engine::getText)
        .function("exportState", &CRDT_Engine::exportState);
}
