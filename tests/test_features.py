import json
import unittest

from helpers import GID, P, ToolCase, dc, full_desired, minimal_desired
from fake_discord import FakeDiscord, base_state

VIEW, SEND = P["VIEW_CHANNEL"], P["SEND_MESSAGES"]


def labels(plan, phase):
    return [op["label"] for op in plan["ops"][phase]]


class FullLayout(ToolCase):
    """Every feature together: plan, apply, and a second plan with nothing left."""

    def test_apply_then_plan_is_empty(self):
        self.assertIdempotent(full_desired())

    def test_apply_order_and_no_deletes(self):
        out = self.apply(full_desired())
        phases = [line.split(":")[0].replace("applied ", "") for line in out.splitlines() if line.startswith("applied ")]
        order = [p for p in dc.PHASES if p in phases]
        self.assertEqual(sorted(set(phases), key=phases.index), order)
        self.assertEqual(set(phases), set(dc.PHASES))
        self.assertTrue(all(c[0] in ("GET", "POST", "PATCH", "PUT") for c in self.fake.calls))

    def test_snapshot_written_before_first_write(self):
        before = dc.fetch(FakeDiscord(base_state()), GID)
        self.apply(full_desired())
        snaps = list(dc.SNAPSHOTS.glob("*-before-apply.json"))
        self.assertEqual(len(snaps), 1)
        snap = json.loads(snaps[0].read_text())
        for key in ("channels", "roles", "onboarding", "welcome_screen", "automod", "guild", "emojis"):
            self.assertEqual(snap[key], before[key], key)

    def test_dry_run_writes_nothing(self):
        code, out, _ = self.run_cli(full_desired(), "apply")
        self.assertEqual(code, 0)
        self.assertIn("Dry run", out)
        self.assertEqual(self.fake.writes(), [])
        self.assertEqual(list(dc.SNAPSHOTS.glob("*")) if dc.SNAPSHOTS.exists() else [], [])

    def test_restore_snapshot_written_before_first_write(self):
        self.apply(full_desired())
        snap = next(dc.SNAPSHOTS.glob("*-before-apply.json"))
        before = dc.fetch(self.fake, GID)
        seen = []
        real = self.fake.request

        def spy(method, path, body=None):
            if method != "GET" and not seen:
                seen.append(list(dc.SNAPSHOTS.glob("*-before-restore.json")))
            return real(method, path, body)

        self.fake.request = spy
        code, out, err = self.run_cli(full_desired(), "restore", str(snap), "--yes")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(len(seen), 1, "restore made no write")
        self.assertEqual(len(seen[0]), 1, "no before-restore snapshot before the first write")
        saved = json.loads(seen[0][0].read_text())
        for key in ("channels", "roles", "onboarding", "welcome_screen", "automod", "guild", "emojis"):
            self.assertEqual(saved[key], before[key], key)
        self.assertIn("snapshot:", out)

    def test_restore_puts_overwrites_onboarding_and_welcome_back(self):
        original = dc.fetch(FakeDiscord(base_state()), GID)
        self.apply(full_desired())
        snap = next(dc.SNAPSHOTS.glob("*-before-apply.json"))
        code, out, _ = self.run_cli(full_desired(), "restore", str(snap))
        self.assertIn("Dry run", out)
        writes = len(self.fake.writes())
        code, out, err = self.run_cli(full_desired(), "restore", str(snap), "--yes")
        self.assertEqual(code, 0, out + err)
        self.assertIn("read-back: restored", out)
        self.assertGreater(len(self.fake.writes()), writes)
        now = dc.fetch(self.fake, GID)
        old = {c["id"]: c for c in original["channels"]}
        for c in now["channels"]:
            if c["id"] in old:
                self.assertEqual(sorted(map(json.dumps, c["permission_overwrites"])),
                                 sorted(map(json.dumps, old[c["id"]]["permission_overwrites"])), c["name"])
                self.assertEqual(c["parent_id"], old[c["id"]]["parent_id"], c["name"])
        self.assertEqual([dc.norm_prompt(p) for p in now["onboarding"]["prompts"]],
                         [dc.norm_prompt(p) for p in original["onboarding"]["prompts"]])
        self.assertEqual(now["onboarding"]["default_channel_ids"], original["onboarding"]["default_channel_ids"])
        self.assertNotIn(dc.WELCOME_FEATURE, now["guild"]["features"])
        self.assertIn("did not exist in the snapshot; left alone", out)
        names = {c["name"] for c in now["channels"]}
        self.assertIn("git-feed", names)  # created channels are never deleted


class Channels(ToolCase):  # F1
    def test_creates_category_and_channels_by_name(self):
        d = minimal_desired()
        d["categories"].append({"name": "Development", "access": "community",
                                "channels": [{"name": "dev-fc", "topic": "FC work"}, {"name": "dev-call", "type": "voice"}]})
        plan = self.plan(d)
        self.assertEqual(labels(plan, "categories")[-1], "Development (category)")
        created = [op for op in plan["ops"]["channels"] if op["action"] == "create"]
        self.assertEqual([op["body"]["type"] for op in created], [0, 2])
        self.assertTrue(all(op["body"]["parent_id"] == "new:channel:Development" for op in created))
        self.assertIdempotent(d)
        dev = self.fake.by_name("Development")
        self.assertEqual(self.fake.by_name("dev-fc")["parent_id"], dev["id"])
        self.assertEqual(self.fake.by_name("dev-fc")["topic"], "FC work")

    def test_matches_existing_channel_by_name_and_parent(self):
        d = minimal_desired()
        d["categories"][0]["channels"] = [{"name": "gen-chat"}, {"name": "builds"}]
        plan = self.plan(d)
        self.assertFalse([op for op in plan["ops"]["channels"] if op["action"] == "create"])
        self.assertIdempotent(d)
        self.assertEqual(len([c for c in self.fake.channels if c["name"] == "gen-chat"]), 1)

    def test_same_name_in_another_category_is_created(self):
        d = minimal_desired()
        d["categories"].append({"id": "200", "name": "Help", "access": "community", "channels": [{"name": "gen-chat"}]})
        plan = self.plan(d)
        self.assertIn("#gen-chat (text)", labels(plan, "channels"))

    def test_text_to_announcement(self):
        d = minimal_desired()
        d["categories"][0]["channels"][0]["type"] = "announcement"
        op = self.plan(d)["ops"]["channels"][0]
        self.assertEqual(op["body"]["type"], 5)
        self.assertEqual(op["diff"]["type"], ("text", "announcement"))
        self.assertIdempotent(d)

    def test_text_cannot_become_forum_by_id(self):
        d = minimal_desired()
        d["categories"][0]["channels"][1]["type"] = "forum"
        self.assertConfigError(d, "cannot change text to forum")

    def test_same_name_other_type_without_id_creates_new_and_notes(self):
        d = minimal_desired()
        d["categories"][0]["channels"][1] = {"name": "builds", "type": "voice"}
        plan = self.plan(d)
        self.assertIn("#builds (voice)", labels(plan, "channels"))
        self.assertTrue(any("same name but another type" in n for n in plan["notes"]))

    def test_names_discord_rewrites_are_refused(self):
        for spec in ({"name": "Dev Chat"}, {"name": "Dev-Chat", "type": "announcement"},
                     {"name": "dev fc", "type": "forum"}):
            d = minimal_desired()
            d["categories"][0]["channels"].append(spec)
            self.assertConfigError(d, f"as {dc.discord_name(spec['name'])!r}; use that name")
        d = minimal_desired()
        d["categories"][0]["channels"].append({"name": "Dev Call", "type": "voice"})
        self.assertIdempotent(d)

    def test_voice_options_validated(self):
        d = minimal_desired()
        d["categories"][0]["channels"][0]["bitrate"] = 64000
        self.assertConfigError(d, "bitrate needs a voice or stage channel")
        d = minimal_desired()
        d["categories"][0]["channels"][0]["type"] = "category"
        self.assertConfigError(d, "type must be one of")


class Forums(ToolCase):  # F2
    def forum_desired(self, **forum):
        d = minimal_desired()
        d["categories"][0]["channels"].append({"name": "help", "type": "forum", "topic": "How to ask",
                                               "slowmode": 30, "forum": forum})
        return d

    def test_create_forum_with_every_setting(self):
        d = self.forum_desired(tags=[{"name": "solved", "emoji": "✅", "moderated": True}, {"name": "fpv", "emoji": ":fpv:"}],
                               default_reaction=":quad:", layout="gallery", sort="creation", require_tag=True, post_slowmode=60)
        op = next(op for op in self.plan(d)["ops"]["channels"] if op["action"] == "create")
        b = op["body"]
        self.assertEqual(b["type"], 15)
        self.assertEqual(b["available_tags"], [
            {"name": "solved", "moderated": True, "emoji_id": None, "emoji_name": "✅"},
            {"name": "fpv", "moderated": False, "emoji_id": "700", "emoji_name": None}])
        self.assertEqual(b["default_reaction_emoji"], {"emoji_id": "701", "emoji_name": None})
        self.assertEqual((b["default_forum_layout"], b["default_sort_order"]), (2, 1))
        self.assertEqual((b["rate_limit_per_user"], b["default_thread_rate_limit_per_user"]), (30, 60))
        self.assertEqual(op["after_create"], {"flags": dc.REQUIRE_TAG})
        self.assertIdempotent(d)
        self.assertEqual(self.fake.by_name("help")["flags"] & dc.REQUIRE_TAG, dc.REQUIRE_TAG)

    def test_update_keeps_tag_ids_and_unlisted_tags(self):
        d = self.forum_desired(tags=[{"name": "a"}, {"name": "b"}])
        self.apply(d)
        ids = {t["name"]: t["id"] for t in self.fake.by_name("help")["available_tags"]}
        self.fake.by_name("help")["available_tags"].append(
            {"id": "8888", "name": "hand-made", "moderated": False, "emoji_id": None, "emoji_name": None})
        d2 = self.forum_desired(tags=[{"name": "b", "moderated": True}, {"name": "a"}, {"name": "c"}], require_tag=False)
        plan = self.plan(d2)
        tags = plan["ops"]["channels"][-1]["body"]["available_tags"]
        self.assertEqual([t.get("id") for t in tags], [ids["b"], ids["a"], None, "8888"])
        self.assertTrue(any("hand-made" in n for n in plan["notes"]))
        self.assertIdempotent(d2)

    def test_limits_and_misuse(self):
        self.assertConfigError(self.forum_desired(tags=[{"name": f"t{i}"} for i in range(21)]), "at most 20 tags")
        self.assertConfigError(self.forum_desired(layout="grid"), "forum.layout")
        self.assertConfigError(self.forum_desired(tags=[{"name": "x", "emoji": ":nope:"}]), "unknown custom emoji")
        d = minimal_desired()
        d["categories"][0]["channels"][0]["forum"] = {"layout": "list"}
        self.assertConfigError(d, "forum settings need a forum")


class Roles(ToolCase):  # F3
    def test_create_update_and_use_new_role_in_access(self):
        d = minimal_desired(roles=[{"name": "Maintainer", "color": "#9b59b6", "hoist": True, "mentionable": True,
                                    "permissions": ["MANAGE_THREADS"]},
                                   {"name": "FPV", "color": "#ff0000", "mentionable": True}])
        d["profiles"]["community"]["Maintainer"] = {"allow": ["VIEW_CHANNEL", "MANAGE_THREADS"]}
        plan = self.plan(d)
        create, update = plan["ops"]["roles"]
        self.assertEqual(create["body"]["colors"], {"primary_color": 0x9B59B6})
        self.assertEqual(create["body"]["permissions"], str(P["MANAGE_THREADS"]))
        self.assertEqual(update["body"], {"colors": {"primary_color": 0xFF0000}, "mentionable": True})
        self.assertIdempotent(d)
        rid = self.fake.role_by_name("Maintainer")["id"]
        gen = self.fake.by_name("gen-chat")
        self.assertIn(rid, [o["id"] for o in gen["permission_overwrites"]])

    def test_managed_roles_skipped_and_unlisted_left_alone(self):
        plan = self.plan(minimal_desired(roles=[{"name": "Integration", "color": "#ffffff"}]))
        self.assertEqual(plan["ops"]["roles"], [])
        self.assertTrue(any("Integration is managed" in n for n in plan["notes"]))
        self.assertIn("beta tester", plan["unmanaged"]["roles"])

    def test_role_above_bot_cannot_be_edited(self):
        state = base_state()
        state["roles"][2]["position"] = 10  # admin above the bot
        self.assertConfigError(minimal_desired(roles=[{"name": "admin", "color": "#000001"}]),
                               "above the bot's role", fake=FakeDiscord(state))

    def test_role_validation(self):
        self.assertConfigError(minimal_desired(roles=[{"name": "X", "color": "blue"}]), "color must be")
        self.assertConfigError(minimal_desired(roles=[{"name": "X", "hoist": "yes"}]), "expected true or false")
        self.assertConfigError(minimal_desired(roles=[{"name": "@everyone"}]), "not managed")


class Positions(ToolCase):  # F4
    def test_reorders_channels_within_category(self):
        d = minimal_desired()
        d["categories"][0]["channels"].reverse()
        op = self.plan(d)["ops"]["positions"][0]
        self.assertEqual(op["body"], [{"id": "102", "position": 4}, {"id": "101", "position": 5}])
        self.assertIdempotent(d)

    def test_relative_order_is_enough(self):
        state = base_state()
        for c in state["channels"]:
            if c["id"] in ("101", "102"):
                c["position"] = {"101": 40, "102": 90}[c["id"]]
        plan = self.plan(minimal_desired(), FakeDiscord(state))
        self.assertEqual(plan["ops"]["positions"], [])

    def test_category_order_from_list(self):
        d = minimal_desired()
        d["categories"].insert(0, {"id": "200", "name": "Help", "access": "community", "channels": []})
        plan = self.plan(d)
        self.assertEqual(labels(plan, "positions"), ["category order"])
        self.assertIdempotent(d)
        cats = sorted((c for c in self.fake.channels if c["type"] == 4), key=lambda c: c["position"])
        names = [c["name"] for c in cats]
        self.assertLess(names.index("Help"), names.index("Chats"))

    def test_unmanaged_siblings_keep_their_slots(self):
        d = minimal_desired()
        d["categories"].append({"id": "200", "name": "Help", "access": "community",
                                "channels": [{"name": "mod-log", "access": "staff"}, {"id": "201", "name": "support"}]})
        d["guard"] = {"protected_channels": ["202"]}
        self.apply(d)
        self.assertEqual(self.fake.chan("202")["position"], 7)


class Archive(ToolCase):  # F5
    def archive_desired(self, refs):
        return minimal_desired(archive={"category": "Archive", "access": "archive", "channels": refs})

    def test_moves_channel_read_only_and_keeps_history(self):
        d = self.archive_desired(["roles"])
        plan = self.plan(d)
        self.assertEqual(labels(plan, "categories")[-1], "Archive (category)")
        self.assertEqual(labels(plan, "archive"), ["#roles (24)"])
        self.assertIdempotent(d)
        roles = self.fake.by_name("roles")
        self.assertEqual(roles["parent_id"], self.fake.by_name("Archive")["id"])
        member = next(o for o in roles["permission_overwrites"] if o["id"] == "10")
        self.assertTrue(int(member["allow"]) & VIEW and int(member["allow"]) & P["READ_MESSAGE_HISTORY"])
        self.assertTrue(int(member["deny"]) & SEND)
        self.assertEqual([c for c in self.fake.calls if c[0] == "DELETE"], [])

    def test_archive_by_id_frees_the_name_for_a_new_forum(self):
        d = self.archive_desired(["102"])
        d["categories"][0]["channels"][1] = {"name": "builds", "type": "forum", "forum": {"layout": "gallery"}}
        plan = self.plan(d)
        self.assertIn("#builds (forum)", labels(plan, "channels"))
        self.assertEqual(labels(plan, "archive"), ["#builds (102)"])
        self.assertIdempotent(d)
        builds = sorted((c for c in self.fake.channels if c["name"] == "builds"), key=lambda c: c["type"])
        self.assertEqual([c["type"] for c in builds], [0, 15])
        self.assertEqual(builds[0]["parent_id"], self.fake.by_name("Archive")["id"])

    def test_archived_id_is_not_matched_by_a_same_type_replacement(self):
        d = self.archive_desired(["201"])
        d["categories"].append({"id": "200", "name": "Help", "access": "community", "channels": [{"name": "support"}]})
        plan = self.plan(d)
        self.assertIn("#support (text)", labels(plan, "channels"))
        self.assertIdempotent(d)
        self.assertEqual(self.fake.chan("201")["parent_id"], self.fake.by_name("Archive")["id"])

    def test_archive_refusals(self):
        self.assertConfigError(self.archive_desired(["101"]), "also listed under categories")
        self.assertConfigError(self.archive_desired(["Chats"]), "no unmanaged channel")
        self.assertConfigError(self.archive_desired(["nope"]), "no unmanaged channel")
        d = self.archive_desired(["web-support"])
        d["guard"] = {"protected_channels": ["202"]}
        self.assertConfigError(d, "protected channel")


class Onboarding(ToolCase):  # F6
    def setUp(self):
        super().setUp()
        self.fake.onboarding["enabled"] = False  # requirements are tested on their own below

    def onboarding_desired(self, **spec):
        return minimal_desired(onboarding=spec)

    def test_existing_prompt_keeps_id_new_prompt_added_unlisted_kept(self):
        d = self.onboarding_desired(mode="advanced", default_channels=["welcome", "rules", "roles", "gen-chat"], prompts=[
            {"title": "Where are you from?", "single_select": True, "required": True,
             "options": [{"title": "Europe", "emoji": "\U0001F1EA\U0001F1FA", "roles": ["Europe", "Member"]},
                         {"title": "Asia", "roles": ["Member"]}]},
            {"title": "What do you fly?", "type": "dropdown", "options": [
                {"title": "FPV", "emoji": ":fpv:", "roles": ["FPV"], "channels": ["builds"]}]}])
        op = self.plan(d)["ops"]["onboarding"][0]
        body = op["body"]
        self.assertEqual([p["title"] for p in body["prompts"]], ["Where are you from?", "What do you fly?", "Legacy prompt"])
        self.assertEqual(body["prompts"][0]["id"], "4000")
        self.assertEqual(body["prompts"][0]["options"][0]["id"], "4001")
        self.assertEqual(body["prompts"][1]["options"][0]["emoji_id"], "700")
        self.assertEqual(body["mode"], 1)
        self.assertIn("default channels: +['#gen-chat'] -[]", op["summary"])
        self.assertIn("prompt 'Where are you from?': new option 'Asia'", op["summary"])
        self.assertIdempotent(d)
        self.assertEqual([p["title"] for p in self.fake.onboarding["prompts"]][2], "Legacy prompt")

    def test_unlisted_options_are_kept(self):
        d = self.onboarding_desired(prompts=[{"title": "Where are you from?", "single_select": True, "required": True,
                                              "options": [{"title": "Asia", "roles": ["Member"]}]}])
        plan = self.plan(d)
        titles = [o["title"] for o in plan["ops"]["onboarding"][0]["body"]["prompts"][0]["options"]]
        self.assertEqual(titles, ["Asia", "Europe"])
        self.assertTrue(any("options not in server.json are kept: Europe" in n for n in plan["notes"]))
        self.assertIdempotent(d)

    def test_option_role_change_is_shown(self):
        d = self.onboarding_desired(prompts=[{"title": "Where are you from?", "single_select": True, "required": True,
                                              "options": [{"title": "Europe", "emoji": "\U0001F1EA\U0001F1FA",
                                                           "roles": ["Europe"]}]}])
        op = self.plan(d)["ops"]["onboarding"][0]
        self.assertIn("prompt 'Where are you from?' option 'Europe': roles +[] -['Member']", op["summary"])

    def test_new_channel_reference_resolves_after_creation(self):
        d = self.onboarding_desired(prompts=[{"title": "Follow", "options": [{"title": "FC", "channels": ["dev-fc"]}]}])
        d["categories"][0]["channels"].append({"name": "dev-fc", "type": "forum"})
        self.assertIdempotent(d)
        follow = next(p for p in self.fake.onboarding["prompts"] if p["title"] == "Follow")
        self.assertEqual(follow["options"][0]["channel_ids"], [self.fake.by_name("dev-fc")["id"]])

    def test_requirements_refused_before_any_write(self):
        self.assertConfigError(self.onboarding_desired(enabled=True, default_channels=["welcome"]),
                               "gives 1 channel(s), 1 writable")
        # a category counts as its channels; Chats channels deny @everyone VIEW_CHANNEL
        seven = self.onboarding_desired(enabled=True, default_channels=["Welcome", "gen-chat", "builds", "support",
                                                                         "General"])
        self.assertEqual(self.plan(seven)["ops"]["onboarding"][0]["body"]["enabled"], True)
        four = self.onboarding_desired(enabled=True, default_channels=["welcome", "rules", "roles", "support",
                                                                        "gen-chat", "builds"])
        self.assertConfigError(four, "gives 6 channel(s), 4 writable")
        code, out, err = self.run_cli(four, "apply", "--yes")
        self.assertEqual(code, 1, out + err)
        self.assertEqual(self.fake.writes(), [])
        # an already enabled onboarding with no change sends nothing and is not checked
        self.fake.onboarding["enabled"] = True
        self.assertEqual(self.plan(self.onboarding_desired(default_channels=["welcome", "rules", "roles"]))
                         ["ops"]["onboarding"], [])

    def test_requirement_errors(self):
        self.assertConfigError(self.onboarding_desired(prompts=[{"title": "X", "options": [{"title": "a", "roles": ["Nope"]}]}]),
                               "unknown role 'Nope'")
        self.assertConfigError(self.onboarding_desired(mode="expert"), "onboarding.mode")


class WelcomeScreen(ToolCase):  # F7
    def test_created_from_nothing(self):
        d = minimal_desired(welcome_screen={"description": "Hi", "channels": [
            {"channel": "rules", "description": "Read", "emoji": "\U0001F4DC"},
            {"channel": "gen-chat", "description": "Talk", "emoji": ":fpv:"}]})
        op = self.plan(d)["ops"]["welcome_screen"][0]
        self.assertEqual(op["body"]["welcome_channels"][1], {"channel_id": "101", "description": "Talk",
                                                              "emoji_id": "700", "emoji_name": "fpv"})
        self.assertTrue(op["body"]["enabled"])
        self.assertIdempotent(d)
        self.assertIn(dc.WELCOME_FEATURE, self.fake.guild["features"])

    def test_at_most_five(self):
        chans = [{"channel": "rules", "description": str(i)} for i in range(6)]
        self.assertConfigError(minimal_desired(welcome_screen={"channels": chans}), "at most 5")


class AutoMod(ToolCase):  # F8
    def test_create_update_and_leave_unlisted(self):
        d = full_desired()
        plan = self.plan(d)
        self.assertEqual(labels(plan, "automod"), ["automod Block Mention Spam", "automod Slurs", "automod Invite links"])
        upd = plan["ops"]["automod"][0]
        self.assertEqual(upd["method"], "PATCH")
        self.assertEqual(upd["body"]["trigger_metadata"], {"mention_total_limit": 10, "mention_raid_protection_enabled": True})
        self.assertEqual(plan["ops"]["automod"][1]["body"]["trigger_metadata"], {"presets": [3]})
        self.assertIdempotent(d)
        alert = self.fake.automod[0]["actions"][1]
        self.assertEqual(alert["metadata"]["channel_id"], self.fake.by_name("mod-log")["id"])

    def test_unlisted_rules_are_reported(self):
        plan = self.plan(minimal_desired(automod=[]))
        self.assertEqual(plan["unmanaged"]["automod rules"], ["Block Mention Spam"])

    def test_caps_and_trigger_changes(self):
        rule = {"name": "Another mention cap", "trigger": "mention_spam", "metadata": {"mention_total_limit": 5},
                "actions": [{"type": "block"}]}
        self.assertConfigError(minimal_desired(automod=[rule]), "allows 1 mention_spam rule")
        rule = {"name": "Block Mention Spam", "trigger": "spam", "actions": [{"type": "block"}]}
        self.assertConfigError(minimal_desired(automod=[rule]), "cannot change a rule's trigger")
        rule = {"name": "x", "trigger": "keyword_preset", "metadata": {"presets": ["rude"]}, "actions": [{"type": "block"}]}
        self.assertConfigError(minimal_desired(automod=[rule]), "unknown presets")


class Guild(ToolCase):  # F9
    def test_description_and_channels(self):
        d = minimal_desired(guild={"description": "New", "rules_channel": "rules", "public_updates_channel": "gen-chat"})
        op = self.plan(d)["ops"]["guild"][0]
        self.assertEqual(op["body"], {"description": "New", "public_updates_channel_id": "101"})
        self.assertIdempotent(d)

    def test_other_guild_settings_rejected(self):
        self.assertConfigError(minimal_desired(guild={"verification_level": 4}), "unknown keys")


class LockoutGuard(ToolCase):  # F10
    def test_deny_view_to_admin(self):
        d = minimal_desired()
        d["profiles"]["community"]["admin"] = {"deny": ["VIEW_CHANNEL"]}
        self.assertConfigError(d, "would deny VIEW_CHANNEL to admin")

    def test_deny_view_to_bot_role(self):
        d = minimal_desired()
        d["categories"][0]["channels"][0]["access"] = {"OpenDrone Dev": {"deny": ["VIEW_CHANNEL"]}}
        self.assertConfigError(d, "would deny VIEW_CHANNEL to OpenDrone Dev")

    def test_member_keeps_view_of_rules(self):
        d = minimal_desired()
        d["categories"].append({"id": "20", "name": "Welcome", "access": {"@everyone": {"deny": ["VIEW_CHANNEL"]}},
                                "channels": [{"id": "22", "name": "rules"}]})
        self.assertConfigError(d, "Member would lose VIEW_CHANNEL on #rules")

    def test_archiving_rules_without_member_view(self):
        d = minimal_desired(archive={"category": "Archive", "access": "staff", "channels": ["welcome"]})
        self.assertConfigError(d, "Member would lose VIEW_CHANNEL on #welcome")

    def test_member_role_permission_change_counts(self):
        state = base_state()
        state["roles"][0]["permissions"] = "0"
        for c in state["channels"]:
            if c["name"] == "rules":
                c["permission_overwrites"] = []
        d = minimal_desired(roles=[{"name": "Member", "permissions": []}])
        self.assertConfigError(d, "Member would lose VIEW_CHANNEL on #rules", fake=FakeDiscord(state))

    def test_protected_role_keeps_administrator(self):
        self.assertConfigError(minimal_desired(roles=[{"name": "admin", "permissions": ["VIEW_CHANNEL"]}]),
                               "role admin would lose ['ADMINISTRATOR']")

    def test_protected_channels_cannot_be_managed(self):
        d = minimal_desired(guard={"protected_channels": ["202"]})
        d["categories"].append({"id": "200", "name": "Help", "access": "community",
                                "channels": [{"id": "202", "name": "web-support"}]})
        self.assertConfigError(d, "protected channel")

    def test_guard_config_checked(self):
        self.assertConfigError(minimal_desired(guard={"protected_roles": ["ghost"]}), "protected role 'ghost'")

    def test_protected_channels_fail_closed(self):
        self.assertConfigError(minimal_desired(guard={"protected_channels": ["web-support"]}),
                               "'web-support' is not a channel id")
        self.assertConfigError(minimal_desired(guard={"protected_channels": ["4242"]}), "channel 4242 does not exist")

    def test_execute_refuses_placeholders(self):
        with self.assertRaises(dc.ConfigError):
            dc.execute(self.fake, {"label": "x", "method": "PATCH", "path": "/channels/1",
                                   "body": {"parent_id": "new:channel:Archive"}})
        self.assertEqual(self.fake.writes(), [])


if __name__ == "__main__":
    unittest.main()
