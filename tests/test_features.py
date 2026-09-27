import copy
import json
import unittest

from helpers import GID, MEMBER_GATED, P, ToolCase, dc, full_desired, minimal_desired
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

    def test_privileged_permissions_are_named_in_compact_output(self):
        perms = ["ADMINISTRATOR", "VIEW_CHANNEL", "SEND_MESSAGES", "ADD_REACTIONS", "EMBED_LINKS", "ATTACH_FILES"]
        d = minimal_desired(roles=[{"name": "Operator", "permissions": perms},
                                   {"name": "developer", "permissions": perms}])
        plan = self.plan(d)
        short = "\n".join(dc.render_plan(plan))
        self.assertIn("+ role Operator\n    color #000000, hoist False, mentionable False\n"
                      "    permissions: [ADMINISTRATOR + 5 more]", short)
        self.assertIn("~ role developer\n    permissions: +[ADMINISTRATOR + 5 more] -[]", short)
        full = "\n".join(dc.render_plan(plan, verbose=True))
        self.assertIn("permissions: [ADMINISTRATOR, ADD_REACTIONS, VIEW_CHANNEL, SEND_MESSAGES, EMBED_LINKS, "
                      "ATTACH_FILES]", full)
        self.assertEqual(dc.fmt_perms(["MANAGE_ROLES", "BAN_MEMBERS", "A", "B", "C"], False),
                         "MANAGE_ROLES, BAN_MEMBERS + 3 more")
        self.assertEqual(dc.fmt_perms(["A", "B", "C", "D", "E"], False), "5 permissions")
        self.assertIn("permissions: [none]", "\n".join(dc.render_plan(self.plan(minimal_desired(
            roles=[{"name": "Plain"}])))))

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
        d = self.archive_desired(["announcements"])
        plan = self.plan(d)
        self.assertEqual(labels(plan, "categories")[-1], "Archive (category)")
        self.assertEqual(labels(plan, "archive"), ["#announcements (23)"])
        self.assertIdempotent(d)
        roles = self.fake.by_name("announcements")
        self.assertEqual(roles["parent_id"], self.fake.by_name("Archive")["id"])
        everyone = next(o for o in roles["permission_overwrites"] if o["id"] == GID)
        self.assertTrue(int(everyone["allow"]) & VIEW and int(everyone["allow"]) & P["READ_MESSAGE_HISTORY"])
        self.assertTrue(int(everyone["deny"]) & SEND)
        self.assertEqual({o["id"] for o in roles["permission_overwrites"]}, {GID})  # the Member overwrite is gone
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

    def test_archiving_a_default_channel_out_of_sight_is_refused(self):
        # #roles is a live onboarding default channel; this archive access hides it from @everyone alone
        d = self.archive_desired(["roles"])
        d["archive"]["access"] = {"@everyone": {"deny": ["VIEW_CHANNEL"]}, "Member": {"allow": ["VIEW_CHANNEL"]}}
        self.assertConfigError(d, "#roles (onboarding default channel) would be hidden from a member holding "
                                  "@everyone; @everyone + Newbie")

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
        d = self.onboarding_desired(mode="advanced", default_channels=["welcome", "rules", "roles", "support"], prompts=[
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
        self.assertIn("default channels: +['#support'] -[]", op["summary"])
        self.assertIn("prompt 'Where are you from?': new option 'Asia': roles [Member]", op["summary"])
        self.assertIn("prompt 'What do you fly?': new, 1 option(s)", op["summary"])
        self.assertIn("prompt 'What do you fly?' option 'FPV': roles [FPV]; channels [#builds]", op["summary"])
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

    def test_new_option_roles_and_channels_are_named_in_the_plan(self):
        d = self.onboarding_desired(prompts=[{"title": "Follow development", "options": [
            {"title": "Flight controllers", "roles": ["OpenFC", "FPV"], "channels": ["dev-fc"]},
            {"title": "Just looking"}]}])
        d["roles"] = [{"name": "OpenFC", "mentionable": True}]
        d["categories"][0]["channels"].append({"name": "dev-fc", "type": "forum"})
        code, out, err = self.run_cli(d, "plan")
        self.assertEqual(code, 0, out + err)
        self.assertIn("prompt 'Follow development': new, 2 option(s)", out)
        self.assertIn("prompt 'Follow development' option 'Flight controllers': roles [OpenFC, FPV]; "
                      "channels [#dev-fc]", out)
        self.assertIn("prompt 'Follow development' option 'Just looking': no roles, no channels", out)

    def self_assign(self, option_roles, prompt="Follow development", **top):
        d = self.onboarding_desired(prompts=[{"title": prompt, "options": [{"title": "Pick me", "roles": option_roles}]}])
        d.update(top)
        return d

    def test_option_granting_a_protected_role_is_refused(self):
        self.assertConfigError(self.self_assign(["admin"]),
                               "onboarding prompt 'Follow development' option 'Pick me' would give role admin to "
                               "any member who picks it; it is a protected role")
        d = self.onboarding_desired(prompts=[{"title": "Where are you from?", "single_select": True, "required": True,
                                              "options": [{"title": "Asia", "roles": ["admin"]}]}])
        self.assertConfigError(d, "option 'Asia' would give role admin")
        self.assertEqual(self.fake.writes(), [])

    def test_option_granting_everyone_managed_or_bot_roles_is_refused(self):
        self.assertConfigError(self.self_assign(["@everyone"]), "role @everyone to any member who picks it; it is @everyone")
        self.assertConfigError(self.self_assign(["Integration"]), "it is managed by an integration")
        self.assertConfigError(self.self_assign(["OpenDrone Dev"]), "role OpenDrone Dev to any member")

    def test_option_granting_a_privileged_role_is_refused(self):
        for perm in dc.PRIVILEGED:
            d = self.self_assign(["Pingers"], roles=[{"name": "Pingers", "permissions": ["VIEW_CHANNEL", perm]}])
            self.assertConfigError(d, f"role Pingers to any member who picks it; it holds {perm}")
        state = base_state()
        state["roles"][3]["permissions"] = str(P["MANAGE_CHANNELS"])  # developer, live
        state["onboarding"]["enabled"] = False
        self.assertConfigError(self.self_assign(["developer"]), "it holds MANAGE_CHANNELS", fake=FakeDiscord(state))

    def test_option_granting_moderation_permissions_is_refused(self):
        # the reviewer's repro: a new 'Helper' role on the 'Where are you from?' Europe option
        mod = ["MANAGE_MESSAGES", "MANAGE_THREADS", "MANAGE_NICKNAMES", "MUTE_MEMBERS", "MOVE_MEMBERS",
               "PIN_MESSAGES", "MANAGE_EVENTS"]
        d = self.onboarding_desired(prompts=[{"title": "Where are you from?", "single_select": True, "required": True,
                                              "options": [{"title": "Europe", "roles": ["Europe", "Member", "Helper"]}]}])
        d["roles"] = [{"name": "Helper", "permissions": mod}]
        self.assertConfigError(d, "option 'Europe' would give role Helper to any member who picks it; it holds "
                                  "MANAGE_MESSAGES, MUTE_MEMBERS, MOVE_MEMBERS, MANAGE_NICKNAMES, MANAGE_EVENTS, "
                                  "MANAGE_THREADS, PIN_MESSAGES")
        self.assertConfigError(self.self_assign(["Mods"], roles=[{"name": "Mods", "permissions": ["MANAGE_MESSAGES"]}]),
                               "role Mods to any member who picks it; it holds MANAGE_MESSAGES")
        # the compact plan names every moderation bit instead of counting it
        del d["onboarding"]
        code, out, err = self.run_cli(d, "plan")
        self.assertEqual(code, 0, out + err)
        self.assertIn("permissions: [MANAGE_MESSAGES, MUTE_MEMBERS, MOVE_MEMBERS, MANAGE_NICKNAMES, MANAGE_EVENTS, "
                      "MANAGE_THREADS, PIN_MESSAGES]", out)
        self.assertNotIn("7 permissions", out)

    def test_unassignable_roles(self):
        self.assertConfigError(self.self_assign(["beta tester"], guard={"unassignable_roles": ["beta tester"]}),
                               "role beta tester to any member who picks it; it is in guard.unassignable_roles")
        self.assertConfigError(self.self_assign(["FPV"], guard={"unassignable_roles": ["Maintainer"]}),
                               "unassignable role 'Maintainer' does not exist")
        d = self.self_assign(["FPV"], guard={"unassignable_roles": ["Maintainer"]},
                             roles=[{"name": "Maintainer", "hoist": True}])
        self.assertEqual(self.plan(d)["ops"]["onboarding"][0]["label"], "onboarding")

    def test_kept_live_option_is_checked(self):
        state = base_state()
        state["roles"][9]["permissions"] = str(dc.ADMIN)  # Europe, granted by the live option 'Europe'
        fake = FakeDiscord(state)
        fake.onboarding["enabled"] = False
        plan = self.plan(minimal_desired(), fake)  # onboarding unmanaged and unchanged: a note
        self.assertTrue(any("option 'Europe' would give role Europe" in n and "onboarding is unchanged" in n
                            for n in plan["notes"]), plan["notes"])
        # a prompt-only change re-sends the kept 'Where are you from?' prompt and its options
        self.assertConfigError(self.self_assign(["FPV"]), "option 'Europe' would give role Europe to any member who "
                               "picks it; it holds ADMINISTRATOR", fake=fake)
        state["roles"][9]["permissions"] = "0"
        self.assertConfigError(minimal_desired(roles=[{"name": "Europe", "permissions": ["BAN_MEMBERS"]}]),
                               "it holds BAN_MEMBERS", fake=FakeDiscord(state))

    def open_forums(self, d, count):
        d["categories"].append({"name": "Showcase", "access": "open", "channels": [
            {"name": f"forum-{i}", "type": "forum"} for i in range(count)]})
        return d

    def test_requirements_refused_before_any_write(self):
        self.assertConfigError(self.onboarding_desired(enabled=True, default_channels=["welcome"]),
                               "conservative estimate of Discord's rule")
        self.assertConfigError(self.onboarding_desired(enabled=True, default_channels=["welcome"]),
                               "gives 1 viewable, 1 writable")
        # Welcome expands to 4 text channels; support is text; General (voice) and web-support (forum) only count
        # towards the 7
        seven = self.onboarding_desired(enabled=True, default_channels=["Welcome", "support", "General", "web-support"])
        self.assertEqual(self.plan(seven)["ops"]["onboarding"][0]["body"]["enabled"], True)
        six = self.onboarding_desired(enabled=True, default_channels=["Welcome", "General", "web-support"])
        self.assertConfigError(six, "gives 6 viewable, 4 writable")
        code, out, err = self.run_cli(six, "apply", "--yes")
        self.assertEqual(code, 1, out + err)
        self.assertEqual(self.fake.writes(), [])

    def test_forums_voice_and_hidden_channels_are_not_writable(self):
        # 4 text + voice + 3 new open forums = 8 viewable, still only 4 writable text channels
        d = self.open_forums(self.onboarding_desired(
            enabled=True, default_channels=["Welcome", "General", "Showcase"]), 3)
        self.assertConfigError(d, "gives 8 viewable, 4 writable")
        # gen-chat and builds deny @everyone VIEW_CHANNEL (staff access), so they add nothing
        d = self.onboarding_desired(enabled=True, default_channels=["Welcome", "Chats", "General"])
        d["categories"][0]["access"] = "staff"
        self.assertConfigError(d, "gives 5 viewable, 4 writable")

    def test_advanced_mode_counts_option_channels(self):
        prompts = [{"title": "Where are you from?", "single_select": True, "required": True,
                    "options": [{"title": "Europe", "roles": ["Europe"], "channels": ["support", "General", "web-support"]}]}]
        base = dict(enabled=True, default_channels=["Welcome"], prompts=prompts)
        self.assertConfigError(self.onboarding_desired(**base), "gives 4 viewable, 4 writable")
        self.assertEqual(self.plan(self.onboarding_desired(mode="advanced", **base))["ops"]["onboarding"][0]["body"]["mode"], 1)

    def prompts_only(self):
        return self.onboarding_desired(prompts=[{"title": "Where are you from?", "single_select": True, "required": True,
                                                 "options": [{"title": "Asia", "roles": ["Member"]}]}])

    def test_prompt_only_change_trusts_discord_when_it_reports_requirements_met(self):
        # the live onboarding has 3 default channels: below this tool's estimate, but Discord accepts it
        self.fake.onboarding.update(enabled=True, below_requirements=False)
        plan = self.plan(self.prompts_only())
        self.assertEqual(len(plan["ops"]["onboarding"]), 1)
        self.assertTrue(any("requirement check is skipped" in n and "3 channel(s)" in n for n in plan["notes"]),
                        plan["notes"])
        self.assertIdempotent(self.prompts_only())

    def test_prompt_only_change_is_checked_when_discord_reports_below_requirements(self):
        self.fake.onboarding.update(enabled=True, below_requirements=True)
        self.assertConfigError(self.prompts_only(), "gives 3 viewable")
        del self.fake.onboarding["below_requirements"]  # unknown counts as below
        self.assertConfigError(self.prompts_only(), "gives 3 viewable")

    def test_settings_change_is_checked_even_when_discord_reports_requirements_met(self):
        self.fake.onboarding.update(enabled=True, below_requirements=False)
        self.assertConfigError(self.onboarding_desired(mode="advanced"), "gives 3 viewable")
        self.assertConfigError(self.onboarding_desired(default_channels=["welcome", "rules"]), "gives 2 viewable")
        # an already enabled onboarding with no change sends nothing and is not checked
        self.assertEqual(self.plan(self.onboarding_desired(default_channels=["welcome", "rules", "roles"]))
                         ["ops"]["onboarding"], [])
        # disabling is never refused
        self.assertEqual(self.plan(self.onboarding_desired(enabled=False))["ops"]["onboarding"][0]["body"]["enabled"],
                         False)

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

    def blind_sets(self, desired, fake=None):
        with self.assertRaises(dc.ConfigError) as ctx:
            self.plan(desired, fake)
        msg = str(ctx.exception)
        self.assertTrue(msg.startswith("lockout guard: "), msg)
        return msg

    def welcome_desired(self, rules_access):
        """Manage the Welcome category; #rules (must_see and an onboarding default channel) gets rules_access."""
        d = minimal_desired()
        d["profiles"]["open"] = {"@everyone": {"allow": ["VIEW_CHANNEL"]}}
        d["categories"].append({"id": "20", "name": "Welcome", "access": "open", "channels": [
            {"id": "21", "name": "welcome"}, {"id": "22", "name": "rules", "access": rules_access},
            {"id": "23", "name": "announcements"}, {"id": "24", "name": "roles"}]})
        return d

    def test_open_layout_passes(self):
        self.assertIdempotent(self.welcome_desired("open"))

    def test_everyone_alone(self):
        d = self.welcome_desired({"@everyone": {"deny": ["VIEW_CHANNEL"]}, "Newbie": {"allow": ["VIEW_CHANNEL"]},
                                  "Member": {"allow": ["VIEW_CHANNEL"]}})
        self.assertTrue(self.blind_sets(d).endswith("#rules (must_see) would be hidden from a member holding @everyone"))

    def test_newbie_deny_left_on_a_default_channel(self):
        # the live pattern: Newbie denied, Member allowed; 414 members hold Newbie
        d = self.welcome_desired({"Newbie": {"deny": ["VIEW_CHANNEL"]}, "Member": {"allow": ["VIEW_CHANNEL"]}})
        d["guard"] = {"must_see": []}
        self.assertTrue(self.blind_sets(d).endswith(
            "#rules (onboarding default channel) would be hidden from a member holding @everyone + Newbie"))

    def test_member_alone(self):
        d = self.welcome_desired({"Member": {"deny": ["VIEW_CHANNEL"]}, "Newbie": {"allow": ["VIEW_CHANNEL"]}})
        self.assertTrue(self.blind_sets(d).endswith("would be hidden from a member holding @everyone + Member"))

    def test_newbie_and_member_together(self):
        d = self.welcome_desired({"Member": {"deny": ["VIEW_CHANNEL"]}, "Newbie": {"deny": ["VIEW_CHANNEL"]}})
        self.assertTrue(self.blind_sets(d).endswith("would be hidden from a member holding @everyone + Newbie; "
                                                    "@everyone + Member; @everyone + Newbie + Member"))

    def test_channels_inside_a_default_category(self):
        self.fake.onboarding["default_channel_ids"] = ["100"]  # the Chats category
        d = minimal_desired(guard={"must_see": []})
        d["profiles"]["community"] = {"Newbie": {"deny": ["VIEW_CHANNEL"]}}
        d["categories"][0]["access"] = {"@everyone": {"allow": ["VIEW_CHANNEL"]}}
        d["categories"][0]["channels"][0]["access"] = "community"
        d["categories"][0]["channels"][1]["access"] = "staff"  # private: @everyone alone cannot see it either
        self.assertTrue(self.blind_sets(d).endswith(
            "#gen-chat (in onboarding default channel Chats) would be hidden from a member holding @everyone + Newbie; "
            "@everyone + Newbie + Member"))  # #builds is private to staff, so it is not checked

    def test_newbie_deny_on_a_managed_channel_everyone_can_see(self):
        # the reviewer's repro: #gen-chat is neither must_see nor an onboarding default channel
        d = minimal_desired(guard={"must_see": []})
        d["categories"][0]["channels"][0]["access"] = {
            "@everyone": {"allow": ["VIEW_CHANNEL", "SEND_MESSAGES"]}, "Newbie": {"deny": ["VIEW_CHANNEL"]}}
        self.assertTrue(self.blind_sets(d).endswith(
            "#gen-chat (managed) would be hidden from a member holding @everyone + Newbie; "
            "@everyone + Newbie + Member"))
        self.assertEqual(self.fake.writes(), [])

    def test_member_deny_on_a_managed_category_everyone_can_see(self):
        d = minimal_desired(guard={"must_see": []})
        d["categories"][0]["access"] = {"@everyone": {"allow": ["VIEW_CHANNEL"]}, "Member": {"deny": ["VIEW_CHANNEL"]}}
        d["categories"][0]["channels"] = [{"id": "101", "name": "gen-chat", "access": "open"}]
        self.assertTrue(self.blind_sets(d).endswith(
            "Chats (managed) would be hidden from a member holding @everyone + Member; @everyone + Newbie + Member"))

    def test_gating_deny_on_an_archived_channel_everyone_can_see(self):
        d = minimal_desired(guard={"must_see": []}, archive={"category": "Archive", "channels": ["102"], "access": {
            "@everyone": {"allow": ["VIEW_CHANNEL"], "deny": ["SEND_MESSAGES"]}, "Newbie": {"deny": ["VIEW_CHANNEL"]}}})
        d["categories"][0]["channels"].pop()
        msg = self.blind_sets(d)
        self.assertIn("#builds (archived) would be hidden from a member holding @everyone + Newbie", msg)
        self.assertIn("Archive (archived) would be hidden", msg)

    def test_staff_channels_are_not_gating_checked(self):
        d = minimal_desired(guard={"must_see": []})
        d["categories"][0]["access"] = "open"
        d["categories"][0]["channels"][1]["access"] = {"@everyone": {"deny": ["VIEW_CHANNEL"]},
                                                       "Newbie": {"deny": ["VIEW_CHANNEL"]},
                                                       "admin": {"allow": ["VIEW_CHANNEL"]}}
        self.assertIdempotent(d)

    def open_channel_with(self, extra):
        """#gen-chat managed with the open profile plus extra role overwrites; must_see off."""
        d = minimal_desired(guard={"must_see": []})
        d["categories"][0]["access"] = "open"
        d["categories"][0]["channels"][0]["access"] = {**copy.deepcopy(d["profiles"]["open"]), **extra}
        return d

    def test_newbie_send_deny_on_a_managed_open_channel(self):
        # a leftover Newbie SEND deny stops the 414 members holding Newbie from posting
        msg = self.blind_sets(self.open_channel_with({"Newbie": {"deny": ["SEND_MESSAGES"]}}))
        self.assertTrue(msg.endswith("#gen-chat (managed) a member holding @everyone + Newbie would lose SEND_MESSAGES; "
                                     "a member holding @everyone + Newbie + Member would lose SEND_MESSAGES"), msg)
        self.assertEqual(self.fake.writes(), [])

    def test_newbie_history_deny_on_a_managed_open_channel(self):
        msg = self.blind_sets(self.open_channel_with({"Newbie": {"deny": ["READ_MESSAGE_HISTORY"]}}))
        self.assertIn("@everyone + Newbie would lose READ_MESSAGE_HISTORY", msg)

    def test_member_denies_on_a_managed_open_channel(self):
        for perm in ("READ_MESSAGE_HISTORY", "SEND_MESSAGES_IN_THREADS", "SEND_MESSAGES"):
            d = self.open_channel_with({"Member": {"deny": [perm]}})
            if perm == "SEND_MESSAGES_IN_THREADS":
                d["categories"][0]["channels"][0]["access"]["@everyone"]["allow"].append(perm)
            msg = self.blind_sets(d)
            self.assertIn(f"#gen-chat (managed) a member holding @everyone + Member would lose {perm}", msg)
            self.assertIn(f"@everyone + Newbie + Member would lose {perm}", msg)

    def test_gating_allow_on_top_of_everyone_passes(self):
        # extra grants to gating roles take nothing away
        self.assertIdempotent(self.open_channel_with({"Member": {"allow": ["ATTACH_FILES"]}}))

    def test_member_gated_community_channel_is_refused(self):
        # the superseded step-2 model: @everyone denied VIEW, Member allowed; members without Member lose the channel
        d = minimal_desired(guard={"must_see": []})
        d["profiles"]["community"] = copy.deepcopy(MEMBER_GATED)
        msg = self.blind_sets(d)
        self.assertIn("Chats (managed) would be hidden from a member holding @everyone; @everyone + Newbie", msg)
        self.assertIn("#gen-chat (managed) would be hidden from a member holding @everyone; @everyone + Newbie", msg)
        d["profiles"]["community"] = {"@everyone": {"deny": ["VIEW_CHANNEL"]}, "Member": {"allow": ["VIEW_CHANNEL"]}}
        self.assertIn("#builds (managed) would be hidden from a member holding @everyone; @everyone + Newbie",
                      self.blind_sets(d))
        self.assertEqual(self.fake.writes(), [])

    def test_member_gated_archive_is_refused(self):
        d = minimal_desired(guard={"must_see": []}, archive={"category": "Archive", "channels": ["102"], "access": {
            "@everyone": {"deny": ["VIEW_CHANNEL"]}, "Member": {"allow": ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"]}}})
        d["categories"][0]["channels"].pop()
        self.assertIn("#builds (archived) would be hidden from a member holding @everyone; @everyone + Newbie",
                      self.blind_sets(d))

    def test_unmanaged_default_channel_is_a_note_until_the_plan_touches_it(self):
        state = base_state()
        roles = next(c for c in state["channels"] if c["name"] == "roles")
        roles["permission_overwrites"].append({"id": "11", "type": 0, "allow": "0", "deny": str(VIEW)})
        fake = FakeDiscord(state)
        plan = self.plan(minimal_desired(), fake)
        self.assertTrue(any(n.startswith("lockout guard: #roles (onboarding default channel) would be hidden from a "
                                         "member holding @everyone + Newbie") and "unmanaged" in n
                            for n in plan["notes"]), plan["notes"])
        fake.onboarding["enabled"] = False
        self.assertConfigError(minimal_desired(onboarding={"enabled": False, "prompts": [
            {"title": "Where are you from?", "single_select": True, "required": True,
             "options": [{"title": "Asia", "roles": ["Member"]}]}]}), "#roles (onboarding default channel)", fake=fake)
        self.assertConfigError(minimal_desired(roles=[{"name": "Newbie", "permissions": ["CHANGE_NICKNAME"]}]),
                               "#roles (onboarding default channel)", fake=fake)

    def test_archiving_welcome_out_of_sight(self):
        d = minimal_desired(archive={"category": "Archive", "access": "staff", "channels": ["welcome"]})
        self.assertConfigError(d, "#welcome (must_see) would be hidden from a member holding @everyone;")

    def test_member_role_permission_change_counts(self):
        state = base_state()
        state["roles"][0]["permissions"] = "0"
        for c in state["channels"]:
            if c["name"] == "rules":
                c["permission_overwrites"] = [{"id": "10", "type": 0, "allow": "0", "deny": "0"}]
        fake = FakeDiscord(state)
        fake.onboarding["default_channel_ids"] = []
        self.assertEqual(self.plan(minimal_desired(guard={"must_see": ["welcome"]}), fake)["total"], 3)
        d = minimal_desired(roles=[{"name": "Member", "permissions": []}], guard={"must_see": ["rules"]})
        self.assertConfigError(d, "#rules (must_see) would be hidden from a member holding @everyone; "
                                  "@everyone + Newbie; @everyone + Member; @everyone + Newbie + Member", fake=fake)

    def test_gating_roles_checked(self):
        self.assertConfigError(minimal_desired(guard={"gating_roles": ["Ghost"]}), "gating role 'Ghost'")
        self.assertConfigError(minimal_desired(guard={"gating_roles": ["a", "b", "c", "d", "e"]}), "at most 4")
        self.assertConfigError(minimal_desired(guard={"member_role": "Member"}), "unknown keys ['member_role']")

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
