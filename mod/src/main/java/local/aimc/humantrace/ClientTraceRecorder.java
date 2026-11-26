package local.aimc.humantrace;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.ClientTickEvent;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

@EventBusSubscriber(modid = HumanTraceMod.MOD_ID, value = Dist.CLIENT)
public final class ClientTraceRecorder {
    private static final Minecraft MC = Minecraft.getInstance();
    private static final Path CONFIG_PATH = Path.of("config", "humantrace-client.properties");
    private static final ConcurrentLinkedQueue<JsonObject> QUEUE = new ConcurrentLinkedQueue<>();
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private static final ScheduledExecutorService SENDER = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "humantrace-http");
        thread.setDaemon(true);
        return thread;
    });
    private static final Properties CONFIG = loadConfig();
    private static final String ENDPOINT = CONFIG.getProperty("endpoint", "http://127.0.0.1:4173/api/traces").trim();
    private static final String SESSION_ID = UUID.randomUUID().toString();
    private static boolean lastAttack, lastUse, lastJump, lastSneak, announced;
    private static long ticks, lastObservationAt, lastMoveAt;
    private static Vec3 previousPosition;
    private static float previousHealth = -1;
    private static String previousInventory = "";
    private static Object previousLevel;

    static {
        SENDER.scheduleAtFixedRate(ClientTraceRecorder::flush, 2, 2, TimeUnit.SECONDS);
    }

    private ClientTraceRecorder() {}

    @SubscribeEvent
    public static void onClientTick(ClientTickEvent.Post event) {
        if (!Boolean.parseBoolean(CONFIG.getProperty("enabled", "true"))) return;
        LocalPlayer player = MC.player;
        if (player == null || MC.level == null) {
            previousPosition = null;
            previousLevel = null;
            return;
        }
        ticks++;
        if (!announced) {
            MC.gui.getChat().addMessage(Component.literal("[Human Trace] 本机轨迹采集已启用；发送目标：" + ENDPOINT));
            announced = true;
        }
        if (previousLevel != MC.level) {
            previousLevel = MC.level;
            previousPosition = null;
            record("observation", "world_session_start", null, player, null);
        }

        boolean attack = MC.options.keyAttack.isDown();
        boolean use = MC.options.keyUse.isDown();
        boolean jump = MC.options.keyJump.isDown();
        boolean sneak = MC.options.keyShift.isDown();
        if (attack && !lastAttack) recordClick("attack", player);
        if (use && !lastUse) recordClick("use", player);
        if (jump && !lastJump) record("jump", "jump_pressed", null, player, null);
        if (sneak != lastSneak) record("sneak", sneak ? "started" : "stopped", null, player, null);
        lastAttack = attack;
        lastUse = use;
        lastJump = jump;
        lastSneak = sneak;

        Vec3 position = player.position();
        if (previousPosition != null && position.distanceToSqr(previousPosition) > 0.0004 && ticks - lastMoveAt >= 5) {
            JsonObject movement = new JsonObject();
            movement.addProperty("dx", position.x - previousPosition.x);
            movement.addProperty("dy", position.y - previousPosition.y);
            movement.addProperty("dz", position.z - previousPosition.z);
            movement.addProperty("forward", MC.options.keyUp.isDown() ? 1 : MC.options.keyDown.isDown() ? -1 : 0);
            movement.addProperty("strafe", MC.options.keyLeft.isDown() ? 1 : MC.options.keyRight.isDown() ? -1 : 0);
            movement.addProperty("sprinting", player.isSprinting());
            record("move", "position_delta", null, player, movement);
            lastMoveAt = ticks;
        }
        previousPosition = position;

        float health = player.getHealth();
        if (previousHealth >= 0 && health < previousHealth) {
            JsonObject damage = new JsonObject();
            damage.addProperty("amount", previousHealth - health);
            record("hurt", "health_decreased", null, player, damage);
        }
        if (player.isDeadOrDying() && previousHealth > 0) record("death", "dead", null, player, null);
        previousHealth = health;

        String inventory = inventorySignature(player);
        if (!inventory.equals(previousInventory)) {
            JsonObject change = new JsonObject();
            change.addProperty("signature", inventory);
            record("inventory", "changed", null, player, change);
            previousInventory = inventory;
        }

        long now = System.currentTimeMillis();
        if (now - lastObservationAt >= 1000) {
            JsonObject state = new JsonObject();
            state.addProperty("health", player.getHealth());
            state.addProperty("maxHealth", player.getMaxHealth());
            state.addProperty("food", player.getFoodData().getFoodLevel());
            state.addProperty("saturation", player.getFoodData().getSaturationLevel());
            state.addProperty("armor", player.getArmorValue());
            state.addProperty("oxygen", player.getAirSupply());
            state.addProperty("onGround", player.onGround());
            state.addProperty("inWater", player.isInWater());
            state.addProperty("inLava", player.isInLava());
            state.addProperty("sprinting", player.isSprinting());
            state.addProperty("sneaking", player.isShiftKeyDown());
            state.addProperty("heldItem", itemName(player.getMainHandItem()));
            state.addProperty("offhandItem", itemName(player.getOffhandItem()));
            state.add("nearbyEntities", nearbyEntities(player));
            record("observation", "snapshot", null, player, state);
            lastObservationAt = now;
        }
    }

    private static void recordClick(String button, LocalPlayer player) {
        HitResult hit = MC.hitResult;
        if (hit instanceof BlockHitResult blockHit && hit.getType() == HitResult.Type.BLOCK) {
            BlockState state = MC.level.getBlockState(blockHit.getBlockPos());
            JsonObject target = blockTarget(blockHit.getBlockPos(), state);
            target.addProperty("heldItem", itemName(player.getMainHandItem()));
            record(button.equals("attack") ? "mine" : "interact", button.equals("attack") ? "block_break_attempt" : "block_use_input", target, player, null);
        } else if (hit instanceof EntityHitResult entityHit) {
            JsonObject target = new JsonObject();
            target.addProperty("entityType", BuiltInRegistries.ENTITY_TYPE.getKey(entityHit.getEntity().getType()).toString());
            target.addProperty("entityId", entityHit.getEntity().getId());
            target.add("position", vector(entityHit.getEntity().position()));
            record(button.equals("attack") ? "attack" : "interact", button.equals("attack") ? "entity_attack_input" : "entity_interact_input", target, player, null);
        } else {
            record(button.equals("attack") ? "attack" : "use_item", button + "_air_input", null, player, null);
        }
    }

    private static JsonObject blockTarget(net.minecraft.core.BlockPos pos, BlockState state) {
        JsonObject target = new JsonObject();
        target.add("pos", vector(new Vec3(pos.getX(), pos.getY(), pos.getZ())));
        target.addProperty("block", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
        return target;
    }

    private static JsonArray nearbyEntities(LocalPlayer player) {
        JsonArray entities = new JsonArray();
        for (Entity entity : MC.level.entitiesForRendering()) {
            if (entity == player || entity instanceof Player) continue;
            double distance = entity.distanceTo(player);
            if (distance > 12 || entities.size() >= 16) continue;
            JsonObject item = new JsonObject();
            item.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString());
            item.addProperty("distance", distance);
            item.add("position", vector(entity.position()));
            item.addProperty("hostile", entity instanceof Mob mob && !mob.getType().getCategory().isFriendly());
            entities.add(item);
        }
        return entities;
    }

    private static String inventorySignature(LocalPlayer player) {
        StringBuilder result = new StringBuilder();
        for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
            ItemStack stack = player.getInventory().getItem(slot);
            if (!stack.isEmpty()) result.append(slot).append(':').append(itemName(stack)).append('x').append(stack.getCount()).append(';');
        }
        for (ItemStack stack : player.getInventory().armor) {
            if (!stack.isEmpty()) result.append("armor:").append(itemName(stack)).append(';');
        }
        return result.toString();
    }

    private static String itemName(ItemStack stack) {
        return stack.isEmpty() ? "" : BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    private static JsonArray vector(Vec3 vector) {
        JsonArray result = new JsonArray();
        result.add(vector.x);
        result.add(vector.y);
        result.add(vector.z);
        return result;
    }

    private static void record(String type, String action, JsonObject target, LocalPlayer player, JsonObject metadata) {
        if (player == null || QUEUE.size() >= 5000) return;
        JsonObject event = new JsonObject();
        event.addProperty("eventId", UUID.randomUUID().toString());
        event.addProperty("at", System.currentTimeMillis());
        event.addProperty("type", type);
        event.addProperty("action", action);
        event.add("position", vector(player.position()));
        event.addProperty("dimension", player.level().dimension().location().toString());
        JsonObject state = new JsonObject();
        state.addProperty("health", player.getHealth());
        state.addProperty("food", player.getFoodData().getFoodLevel());
        state.addProperty("armor", player.getArmorValue());
        event.add("state", state);
        if (target != null) event.add("target", target);
        if (metadata != null) event.add("metadata", metadata);
        QUEUE.add(event);
    }

    private static void flush() {
        if (QUEUE.isEmpty()) return;
        JsonObject body = new JsonObject();
        body.addProperty("sessionId", SESSION_ID);
        JsonArray events = new JsonArray();
        List<JsonObject> batch = new ArrayList<>(100);
        for (int i = 0; i < 100; i++) {
            JsonObject item = QUEUE.poll();
            if (item == null) break;
            batch.add(item);
            events.add(item);
        }
        if (batch.isEmpty()) return;
        body.add("events", events);
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(ENDPOINT))
                    .timeout(Duration.ofSeconds(8))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                    .build();
            HTTP.sendAsync(request, HttpResponse.BodyHandlers.discarding()).thenAccept(response -> {
                if (response.statusCode() < 200 || response.statusCode() >= 300) restore(batch);
            }).exceptionally(error -> { restore(batch); return null; });
        } catch (IllegalArgumentException error) {
            restore(batch);
        }
    }

    private static void restore(List<JsonObject> batch) {
        for (int i = batch.size() - 1; i >= 0; i--) QUEUE.add(batch.get(i));
    }

    private static Properties loadConfig() {
        Properties properties = new Properties();
        try {
            Files.createDirectories(CONFIG_PATH.getParent());
            if (Files.exists(CONFIG_PATH)) {
                try (var input = Files.newInputStream(CONFIG_PATH)) { properties.load(input); }
            } else {
                properties.setProperty("enabled", "true");
                properties.setProperty("endpoint", "http://127.0.0.1:4173/api/traces");
                try (var output = Files.newOutputStream(CONFIG_PATH)) { properties.store(output, "Human Trace client settings"); }
            }
        } catch (IOException error) {
            properties.setProperty("enabled", "false");
        }
        return properties;
    }
}
